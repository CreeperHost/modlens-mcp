import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeHub } from '../dist/runtime/hub.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const javaHome = process.env.MODLENS_TEST_JAVA_HOME || process.env.MODLENS_JAVA8_HOME;
if (!javaHome) throw new Error('Set MODLENS_TEST_JAVA_HOME to a Java 8 or newer JDK');
const executable = name => join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
const root = await mkdtemp(join(tmpdir(), 'modlens-runtime-legacy-'));
const project = join(root, 'legacy-project');
const hub = new RuntimeHub(join(root, 'cache'));
let game;
try {
    await mkdir(join(project, 'gradle', 'wrapper'), { recursive: true });
    await writeFile(join(project, 'gradle', 'wrapper', 'gradle-wrapper.jar'), 'fixture');
    const setup = await hub.setup(project, 'interactive', 'runClient', true, '1.7.10');
    assert.deepEqual(setup.vmOptions, [setup.vmOption]);
    const fixture = join(repo, 'runtime-agent/test/legacy-fixture');
    execFileSync(executable('javac'), ['-d', root,
        join(fixture, 'org/lwjgl/opengl/Display.java'),
        join(fixture, 'org/lwjgl/opengl/GL11.java'),
        join(fixture, 'org/lwjgl/input/Keyboard.java'),
        join(fixture, 'org/lwjgl/input/Mouse.java'),
        join(fixture, 'net/minecraft/CrashReport.java'),
        join(repo, 'runtime-agent/test/io/modlens/runtime/LegacySmoke.java')]);
    game = spawn(executable('java'), [setup.vmOption, '-cp', root,
        'io.modlens.runtime.LegacySmoke', root], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let gameError = '', gameOutput = '';
    game.stderr.on('data', bytes => { gameError += bytes; });
    game.stdout.on('data', bytes => { gameOutput += bytes; });
    const gameDone = once(game, 'exit');
    const deadline = Date.now() + 20000;
    let session;
    while (Date.now() < deadline) {
        session = (await hub.list()).find(s => s.capabilities.target === '1.7.10' && s.capabilities.inputBackend === 'lwjgl2');
        if (session) break;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(session, gameError || 'Legacy agent did not connect');
    assert.equal(session.capabilities.inputBackend, 'lwjgl2');
    assert.equal(session.capabilities.threads, true);
    assert.ok(session.javaVersion);
    assert.ok(session.metrics.heapUsed > 0);
    const threads = await hub.command(session.sessionId, { type: 'threads' });
    const report = await hub.artifact(session.sessionId, threads.artifact);
    assert.match(report.text, /ModLens telemetry/);
    assert.equal((await hub.command(session.sessionId, { type: 'mode', mode: 'observe' })).mode, 'observe');
    assert.equal((await hub.command(session.sessionId, { type: 'key', key: 'W', down: true, holdMs: 100 })).state, 'event_delivered');
    assert.equal((await hub.command(session.sessionId, { type: 'mouse_button', button: 1, down: true, holdMs: 100 })).state, 'event_delivered');
    assert.equal((await hub.command(session.sessionId, { type: 'scroll', y: 1, x: 0 })).state, 'event_delivered');
    const frame = await hub.command(session.sessionId, { type: 'screenshot' });
    assert.equal((await hub.artifact(session.sessionId, frame.artifact)).mimeType, 'image/png');
    assert.match(gameOutput, /KEY 17 true/);
    assert.match(gameOutput, /MOUSE 0 0/);
    assert.match(gameOutput, /MOUSE -1 120/);
    const events = await hub.events();
    assert.ok(events.events.some(e => e.type === 'agent_started'));
    assert.ok(events.events.some(e => e.type === 'minecraft_crash'));
    await writeFile(join(root, 'finish'), 'done');
    assert.equal((await gameDone)[0], 0, gameError);
    console.log(`PASS: one packaged agent runs on Java ${session.javaVersion}, hooks LWJGL2 keyboard/mouse events and screenshots, and reports diagnostics`);
} finally {
    if (game && game.exitCode === null) game.kill();
    await hub.close();
    await rm(root, { recursive: true, force: true });
}
