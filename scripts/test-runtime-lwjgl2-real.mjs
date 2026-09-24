import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeHub } from '../dist/runtime/hub.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const javaHome = process.env.MODLENS_TEST_JAVA_HOME;
const lwjgl = process.env.MODLENS_LWJGL2_CLASSPATH;
if (!javaHome || !lwjgl) throw new Error('Set MODLENS_TEST_JAVA_HOME and MODLENS_LWJGL2_CLASSPATH');
const bin = name => join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
const root = await mkdtemp(join(tmpdir(), 'modlens-real-lwjgl2-'));
const project = join(root, 'project');
const agent = join(repo, 'dist/runtime/modlens-agent.jar');
const classpath = [root, agent, lwjgl].join(delimiter);
const hub = new RuntimeHub(join(root, 'cache'));
let game;
try {
    await mkdir(join(project, 'gradle', 'wrapper'), { recursive: true });
    await writeFile(join(project, 'gradle', 'wrapper', 'gradle-wrapper.jar'), 'fixture');
    const setup = await hub.setup(project, 'observe', 'runClient', true, '1.7.10');
    execFileSync(bin('javac'), ['-cp', classpath, '-d', root,
        join(repo, 'runtime-agent/test/io/modlens/runtime/RealLwjgl2Smoke.java')]);
    game = spawn(bin('java'), [setup.vmOption, '-cp', classpath,
        'io.modlens.runtime.RealLwjgl2Smoke', root],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '', error = '';
    game.stdout.on('data', bytes => { output += bytes; });
    game.stderr.on('data', bytes => { error += bytes; });
    const done = once(game, 'exit');
    const deadline = Date.now() + 20000;
    let session;
    while (Date.now() < deadline) {
        session = (await hub.list()).find(s => s.capabilities.inputBackend === 'lwjgl2');
        if (session) break;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(session, error || 'LWJGL2 agent did not connect');
    assert.equal((await hub.command(session.sessionId, { type: 'key', key: 'W', down: true, holdMs: 500 })).state, 'event_delivered');
    assert.equal((await hub.command(session.sessionId, { type: 'mouse_button', button: 1, down: true, holdMs: 500 })).state, 'event_delivered');
    assert.equal((await hub.command(session.sessionId, { type: 'scroll', x: 0, y: 1 })).state, 'event_delivered');
    const events = (await hub.events()).events;
    assert.ok(events.some(e => e.type === 'hooks_installed' && e.data.class === 'org/lwjgl/input/Keyboard'));
    assert.ok(events.some(e => e.type === 'hooks_installed' && e.data.class === 'org/lwjgl/input/Mouse'));
    assert.ok(events.some(e => e.type === 'hooks_installed' && e.data.class === 'org/lwjgl/opengl/Display'));
    assert.match(output, /KEY 17 true/);
    assert.match(output, /MOUSE 0 0/);
    assert.match(output, /MOUSE -1 120/);
    await writeFile(join(root, 'finish'), 'done');
    assert.equal((await done)[0], 0, error);
    console.log('PASS: one packaged Java 8 agent instruments actual LWJGL2 keyboard and mouse classes');
} finally {
    if (game && game.exitCode === null) game.kill();
    await hub.close();
    await rm(root, { recursive: true, force: true });
}
