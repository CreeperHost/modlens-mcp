import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeHub } from '../dist/runtime/hub.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const javaHome = process.env.MODLENS_TEST_JAVA_HOME;
const native = Boolean(process.env.MODLENS_GLFW_CLASSPATH);
if (!javaHome) throw new Error('Set MODLENS_TEST_JAVA_HOME to a Java 17 or newer JDK');
const executable = name => join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
const root = await mkdtemp(join(tmpdir(), 'modlens-runtime-glfw-'));
const project = join(root, 'glfw-project');
const hub = new RuntimeHub(join(root, 'cache'));
let game;
let gameDone;
try {
    await mkdir(join(project, 'gradle', 'wrapper'), { recursive: true });
    await writeFile(join(project, 'gradle', 'wrapper', 'gradle-wrapper.jar'), 'fixture');
    const setup = await hub.setup(project, native ? 'hidden' : 'observe', 'runClient', true, '1.20.1');
    assert.deepEqual(setup.vmOptions, [setup.vmOption]);
    const files = [];
    if (native) files.push(join(repo, 'runtime-agent/test/io/modlens/runtime/NativeGlfwSmoke.java'));
    else {
        const fixture = join(repo, 'runtime-agent/test/legacy-fixture/org/lwjgl/glfw');
        files.push(...(await readdir(fixture)).filter(name => name.endsWith('.java')).map(name => join(fixture, name)));
        files.push(join(repo, 'runtime-agent/test/legacy-fixture/org/lwjgl/opengl/GL11.java'));
        files.push(join(repo, 'runtime-agent/test/io/modlens/runtime/GlfwSmoke.java'));
    }
    const classpath = [root, process.env.MODLENS_GLFW_CLASSPATH].filter(Boolean).join(delimiter);
    execFileSync(executable('javac'), ['-cp', classpath, '-d', root, ...files]);
    game = spawn(executable('java'), [`-Djava.io.tmpdir=${root}`, setup.vmOption, '-cp', classpath,
        native ? 'io.modlens.runtime.NativeGlfwSmoke' : 'io.modlens.runtime.GlfwSmoke', root],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '', error = '';
    game.stdout.on('data', bytes => { output += bytes; });
    game.stderr.on('data', bytes => { error += bytes; });
    gameDone = once(game, 'exit');
    const deadline = Date.now() + 20000;
    let session;
    while (Date.now() < deadline) {
        session = (await hub.list()).find(s => s.capabilities.target === '1.20.1' && s.capabilities.inputBackend === 'glfw');
        if (session) break;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(session, error || 'GLFW agent did not connect');
    assert.equal(session.capabilities.jfr, true, JSON.stringify(await hub.events()));
    const act = async command => {
        try { return await hub.command(session.sessionId, command); }
        catch (cause) { throw new Error(`${cause}\n${JSON.stringify(await hub.events())}\n${error}`); }
    };
    assert.equal((await act({ type: 'key', key: 'W', down: true, holdMs: 100 })).state, 'event_delivered');
    assert.equal((await act({ type: 'mouse_button', button: 1, down: true, holdMs: 100 })).state, 'event_delivered');
    assert.equal((await act({ type: 'mouse_move', x: 12, y: 5, relative: false })).state, 'event_delivered');
    assert.equal((await act({ type: 'scroll', x: 0, y: 1 })).state, 'event_delivered');
    assert.equal((await act({ type: 'text', text: 'A' })).state, 'event_delivered');
    const frame = await act({ type: 'screenshot' });
    assert.equal((await hub.artifact(session.sessionId, frame.artifact)).mimeType, 'image/png');
    const recording = await act({ type: 'recording' });
    assert.match(recording.artifact, /\.jfr$/);
    const allocations = await act({ type: 'allocations', packagePrefix: 'io.modlens.runtime' });
    const report = await hub.artifact(session.sessionId, allocations.artifact);
    assert.equal(JSON.parse(report.text).kind, 'sampled_allocation_pressure');
    assert.equal((await act({ type: 'mode', mode: 'hidden' })).mode, 'hidden');
    await writeFile(join(root, 'finish'), 'done');
    assert.equal((await gameDone)[0], 0, error);
    for (const marker of ['KEY 87 1', 'BUTTON 0 1', 'MOVE 12.0 5.0', 'SCROLL 0.0 1.0', 'CHAR 65'])
        assert.match(output, new RegExp(marker.replaceAll('.', '\\.')));
    assert.equal((output.match(/KEY 87 1/g) ?? []).length, 1, 'physical key events must be filtered in observe mode');
    console.log(`PASS: one packaged agent hooks ${native ? 'native ' : ''}GLFW callbacks, filters physical input, injects commands, captures a frame, and hides the window`);
} finally {
    if (game && game.exitCode === null) {
        game.kill();
        await gameDone?.catch(() => {});
    }
    await hub.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
