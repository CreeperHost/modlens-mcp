// Real Gradle -> export -> ModLens source/member/search assertions. No game launch.
// Set MODLENS_TEST_GRADLE_HOME and JAVA_HOME. Optional argument: moddev (NeoForge 1.21.1).
// Uses a disposable fixture; retained on failure for diagnosis.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from '../dist/tools/project.js';

const moddev = process.argv[2] === 'moddev';
const root = await mkdtemp(join(tmpdir(), 'modlens-gradle-smoke-'));
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gradleHome = process.env.MODLENS_TEST_GRADLE_HOME;
if (!gradleHome || !process.env.JAVA_HOME) throw new Error('Set MODLENS_TEST_GRADLE_HOME and JAVA_HOME');
const launcher = (await readdir(join(gradleHome, 'lib'))).find(n => /^gradle-launcher-.*\.jar$/.test(n));
if (!launcher) throw new Error('Gradle launcher JAR missing');
const java = join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const write = async (path, text) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); };
const run = (sourceSet = 'main') => execFileSync(java, ['-classpath', join(gradleHome, 'lib', launcher), 'org.gradle.launcher.GradleMain',
    '--no-daemon', '--console=plain', '--no-configuration-cache', '-I', join(repo, 'scripts/gradle/modlens.init.gradle'), `-PmodlensSourceSet=${sourceSet}`, ':modlensExport'],
    { cwd: root, env: process.env, stdio: 'inherit', timeout: 1200_000 });
let passed = false;
try {
    if (moddev) {
        await write('settings.gradle', "pluginManagement { repositories { gradlePluginPortal(); maven { url = 'https://maven.neoforged.net/releases' } } }\nrootProject.name = 'modlens-at-smoke'\n");
        await write('build.gradle', "plugins { id 'java'; id 'net.neoforged.moddev' version '2.0.141' }\njava { toolchain { languageVersion = JavaLanguageVersion.of(21) } }\nneoForge { version = '21.1.209' }\n");
        await write('gradle.properties', 'minecraft_version=1.21.1\norg.gradle.jvmargs=-Xmx3G\n');
        await write('src/main/resources/META-INF/accesstransformer.cfg', '# baseline\n');
    } else {
        await write('settings.gradle', "rootProject.name = 'modlens-classpath-smoke'\ninclude 'library'\n");
        await write('build.gradle', "plugins { id 'java' }\ndependencies { implementation project(':library') }\nsourceSets { client { compileClasspath = sourceSets.main.compileClasspath } }\n");
        await write('library/build.gradle', "plugins { id 'java' }\n");
        await write('library/src/main/java/example/Target.java', 'package example; public class Target { private final int counter = 7; public int read() { return counter; } }\n');
    }
    run();
    const key = (await readFile(join(root, '.gradle/modlens/project-key.txt'), 'utf8')).trim();
    const store = new ProjectStore(join(root, 'server-projects'));
    const first = await store.importBuffer(key, await readFile(join(root, 'build/modlens/main/environment.zip')));
    const target = moddev ? 'net.minecraft.world.level.Level' : 'example.Target';
    const fieldName = moddev ? 'isDebug' : 'counter';
    const field = async id => (await store.members(key, id, target)).result.fields.find(f => f.name === fieldName);
    const before = await field(first.environmentId);
    assert.ok(before, `Missing ${fieldName}`);
    assert.ok(before.access & 0x10, 'baseline field must be final');
    if (moddev) await write('src/main/resources/META-INF/accesstransformer.cfg', 'public-f net.minecraft.world.level.Level isDebug\n');
    else await write('library/src/main/java/example/Target.java', 'package example; public class Target { public int counter = 7; public int read() { return counter; } }\n');
    run();
    assert.equal((await readFile(join(root, '.gradle/modlens/project-key.txt'), 'utf8')).trim(), key, 'export must preserve private key');
    const second = await store.importBuffer(key, await readFile(join(root, 'build/modlens/main/environment.zip')));
    assert.notEqual(first.environmentId, second.environmentId);
    const after = await field(second.environmentId);
    assert.ok(after.access & 1, 'transformed field must be public');
    assert.equal(after.access & 0x10, 0, 'transformed field must not be final');
    assert.ok((await field(first.environmentId)).access & 0x10, 'baseline must stay final');
    const source = await store.source(key, second.environmentId, target, 1, 1000);
    assert.match(source.source, new RegExp(`public (?!final)\\w+ ${fieldName}`));
    if (moddev) assert.equal(source.origin, 'gradle-sources', 'adapter must supply actual transformed sources');
    const search = await store.search(key, second.environmentId, `public ${moddev ? 'boolean' : 'int'} ${fieldName}`, 200);
    assert.ok(search.results.some(r => r.className === target.replaceAll('.', '/')));
    assert.equal((await store.list('f'.repeat(64))).length, 0);
    if (!moddev) {
        run('client'); // sibling :library has no client source set and must not break this export
        const client = await store.importBuffer(key, await readFile(join(root, 'build/modlens/client/environment.zip')));
        assert.equal(client.sourceSet, 'client');
        assert.equal((await field(client.environmentId)).access, 1);
    }
    console.log(JSON.stringify({ passed: true, toolchain: second.toolchain, beforeAccess: before.access, afterAccess: after.access,
        classCount: second.classCount, sourceCount: second.sourceCount, first: first.environmentId, second: second.environmentId }, null, 2));
    // Keep a bundle for the optional HTTP smoke, without copying any project key into the repository.
    if (process.env.MODLENS_KEEP_FIXTURE !== '1') passed = true;
} finally {
    if (passed) await rm(root, { recursive: true, force: true });
    else console.log(`Fixture retained: ${root}`);
}
