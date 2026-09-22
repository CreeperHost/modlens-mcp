package io.modlens.runtime;

import io.modlens.runtime.bridge.Hooks;
import java.io.*;
import java.lang.instrument.Instrumentation;
import java.lang.management.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import jdk.jfr.Recording;

final class RuntimeAgent {

    final String sessionId = UUID.randomUUID().toString();
    final long startedAt = System.currentTimeMillis();
    final Path configPath, artifacts;
    final SdlAdapter adapter;
    final BlockingQueue<Properties> commands = new ArrayBlockingQueue<>(16);
    private final ArrayDeque<Map<String, Object>> events = new ArrayDeque<>();
    private final ArrayDeque<Map<String, Object>> results = new ArrayDeque<>();
    private final Set<String> received = new LinkedHashSet<>();
    private final Object exchangeLock = new Object();
    private long sequence, lastSample, lastGc, lastPressure;
    private int pressureSamples;
    volatile long lastConnected = System.currentTimeMillis();
    private volatile Map<String, Object> metrics = Map.of();
    private Recording recording;
    private final ExecutorService io = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "ModLens artifacts");
        t.setDaemon(true);
        return t;
    });

    static void start(Path config, Instrumentation instrumentation) throws Exception {
        RuntimeAgent agent = new RuntimeAgent(config);
        Hooks.handler = agent.adapter;
        instrumentation.addTransformer(new Transformer(instrumentation, agent, agent.adapter.minecraftHooks));
        var previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            agent.failure("uncaught_exception", thread.getName(), error);
            if (previous != null) previous.uncaughtException(thread, error);
            else error.printStackTrace();
        });
        agent.startRecording();
        Thread worker = new Thread(agent::loop, "ModLens telemetry");
        worker.setDaemon(true);
        worker.start();
        Runtime.getRuntime().addShutdownHook(
            new Thread(() -> {
                agent.event("jvm_shutdown", Map.of());
                try {
                    agent.exchange();
                } catch (Exception ignored) {}
                if (agent.recording != null) agent.recording.close();
                agent.io.shutdown();
            }, "ModLens shutdown")
        );
        agent.event(
            "agent_started",
            Map.of(
                "pid",
                ProcessHandle.current().pid(),
                "javaVersion",
                System.getProperty("java.version"),
                "target",
                "26.3"
            )
        );
    }

    RuntimeAgent(Path config) throws Exception {
        configPath = config.toAbsolutePath();
        Properties p = configuration();
        if (!"26.3".equals(p.getProperty("mcVersion"))) throw new IllegalArgumentException(
            "This agent targets Minecraft 26.3 only"
        );
        artifacts = configPath.getParent().resolve("sessions").resolve(sessionId);
        Files.createDirectories(artifacts);
        adapter = new SdlAdapter(
            this,
            p.getProperty("mode", "interactive"),
            Boolean.parseBoolean(p.getProperty("minecraftHooks", "true"))
        );
    }

    private Properties configuration() throws IOException {
        var p = new Properties();
        try (var in = Files.newInputStream(configPath)) {
            p.load(in);
        }
        return p;
    }

    synchronized void event(String type, Map<String, ?> data) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("seq", ++sequence);
        e.put("time", System.currentTimeMillis());
        e.put("type", type);
        e.put("data", data);
        if (events.size() >= 256) events.removeFirst();
        events.addLast(e);
    }

    synchronized void complete(Properties command, boolean ok, Object data) {
        if (results.size() >= 20) results.removeFirst();
        results.addLast(Map.of("id", command.getProperty("id"), "ok", ok, "data", data));
    }

    void failure(String type, String thread, Throwable error) {
        try {
            StringWriter text = new StringWriter();
            error.printStackTrace(new PrintWriter(text));
            String bounded = text.toString();
            if (bounded.length() > 24_000) bounded = bounded.substring(0, 24_000);
            String name = "failure-" + System.currentTimeMillis() + ".txt";
            Files.writeString(artifacts.resolve(name), bounded);
            event(
                type,
                Map.of(
                    "thread",
                    thread,
                    "exception",
                    error.getClass().getName(),
                    "stack",
                    bounded,
                    "artifact",
                    name
                )
            );
        } catch (Throwable ignored) {}
    }

    private void startRecording() {
        try {
            recording = new Recording();
            recording.setName("ModLens rolling diagnostics");
            recording.setMaxAge(Duration.ofMinutes(2));
            recording.setMaxSize(16 * 1024 * 1024);
            for (String event : List.of(
                "jdk.GarbageCollection",
                "jdk.GCHeapSummary",
                "jdk.JavaErrorThrow",
                "jdk.ThreadPark",
                "jdk.JavaMonitorEnter"
            ))
                recording.enable(event).withThreshold(Duration.ofMillis(20));
            recording.enable("jdk.CPULoad").withPeriod(Duration.ofSeconds(1));
            recording.enable("jdk.ObjectAllocationSample").withStackTrace();
            recording.start();
        } catch (Throwable e) {
            event("jfr_unavailable", Map.of("reason", e.toString()));
            recording = null;
        }
    }

    private void sample() {
        long now = System.currentTimeMillis();
        if (now - lastSample < 1000) return;
        MemoryUsage heap = ManagementFactory.getMemoryMXBean().getHeapMemoryUsage();
        long gcTime = 0,
            gcCount = 0;
        for (var gc : ManagementFactory.getGarbageCollectorMXBeans()) {
            gcTime += Math.max(0, gc.getCollectionTime());
            gcCount += Math.max(0, gc.getCollectionCount());
        }
        double gcRatio = lastSample == 0 ? 0 : Math.max(0, (gcTime - lastGc) / (double) (now - lastSample));
        var m = new LinkedHashMap<String, Object>();
        m.put("time", now);
        m.put("heapUsed", heap.getUsed());
        m.put("heapCommitted", heap.getCommitted());
        m.put("heapMax", heap.getMax());
        m.put("nonHeapUsed", ManagementFactory.getMemoryMXBean().getNonHeapMemoryUsage().getUsed());
        m.put("gcCount", gcCount);
        m.put("gcTimeMs", gcTime);
        m.put("gcCollectionTimeRatio", gcRatio);
        m.put("threads", ManagementFactory.getThreadMXBean().getThreadCount());
        m.put(
            "note",
            "GC collection time may include concurrent work; it is not a stop-the-world pause percentage."
        );
        metrics = m;
        if (gcRatio > 0.2 && heap.getMax() > 0 && heap.getUsed() > heap.getMax() * 0.8) pressureSamples++;
        else pressureSamples = 0;
        if (pressureSamples >= 3 && now - lastPressure > 30_000) {
            lastPressure = now;
            event("memory_pressure", m);
        }
        lastSample = now;
        lastGc = gcTime;
    }

    private void loop() {
        while (true) {
            try {
                sample();
                exchange();
                Thread.sleep(100);
            } catch (InterruptedException e) {
                return;
            } catch (Exception e) {
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException ignored) {
                    return;
                }
            }
        }
    }

    private void exchange() throws Exception {
        synchronized (exchangeLock) {
            exchangeLocked();
        }
    }

    private void exchangeLocked() throws Exception {
        Properties p = configuration();
        URI uri = URI.create(p.getProperty("endpoint"));
        if (
            !"http".equals(uri.getScheme()) || !"127.0.0.1".equals(uri.getHost()) || uri.getUserInfo() != null
        ) throw new IOException("Runtime bridge must be loopback HTTP");
        List<Map<String, Object>> batch, completed;
        synchronized (this) {
            batch = events.stream().limit(2).toList();
            completed = List.copyOf(results);
        }
        var packet = new LinkedHashMap<String, Object>();
        packet.put("protocol", 1);
        packet.put("sessionId", sessionId);
        packet.put("pid", ProcessHandle.current().pid());
        packet.put("startedAt", startedAt);
        packet.put("javaVersion", System.getProperty("java.version"));
        packet.put("capabilities", adapter.capabilities(recording != null));
        packet.put("state", adapter.state());
        packet.put("metrics", metrics);
        packet.put("events", batch);
        packet.put("results", completed);
        byte[] bytes = Json.encode(packet).getBytes(StandardCharsets.UTF_8);
        HttpURLConnection conn = (HttpURLConnection) uri.toURL().openConnection();
        conn.setConnectTimeout(1000);
        conn.setReadTimeout(1000);
        conn.setInstanceFollowRedirects(false);
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setRequestProperty("Authorization", "Bearer " + p.getProperty("token"));
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setFixedLengthStreamingMode(bytes.length);
        try {
            try (var out = conn.getOutputStream()) {
                out.write(bytes);
            }
            if (conn.getResponseCode() != 200) throw new IOException("Bridge unavailable");
            Properties response = new Properties();
            try (var in = conn.getInputStream()) {
                response.load(in);
            }
            long ack = Long.parseLong(response.getProperty("ack", "0"));
            synchronized (this) {
                events.removeIf(e -> ((Number) e.get("seq")).longValue() <= ack);
                results.removeAll(completed);
            }
            lastConnected = System.currentTimeMillis();
            if (response.containsKey("id") && received.add(response.getProperty("id"))) {
                if (received.size() > 256) received.remove(received.iterator().next());
                String type = response.getProperty("type");
                if (Set.of("threads", "recording", "allocations").contains(type)) io.execute(() ->
                    diagnostic(response)
                );
                else if (!commands.offer(response)) complete(
                    response,
                    false,
                    Map.of("error", "Client command queue is full")
                );
            }
        } finally {
            conn.disconnect();
        }
    }

    private void diagnostic(Properties c) {
        try {
            String name;
            if (c.getProperty("type").equals("threads")) {
                name = "threads-" + System.currentTimeMillis() + ".txt";
                var text = new StringBuilder();
                for (var info : ManagementFactory.getThreadMXBean().dumpAllThreads(true, true)) {
                    if (text.length() > 1_000_000) break;
                    text.append('"')
                        .append(info.getThreadName())
                        .append("\" id=")
                        .append(info.getThreadId())
                        .append(' ')
                        .append(info.getThreadState())
                        .append('\n');
                    if (info.getLockInfo() != null) text.append("  waiting on ")
                        .append(info.getLockInfo())
                        .append(" owned by ")
                        .append(info.getLockOwnerName())
                        .append('\n');
                    // ThreadInfo.toString truncates stacks; diagnostics need the full trace.
                    for (var frame : info.getStackTrace()) text.append("    at ").append(frame).append('\n');
                    for (var lock : info.getLockedMonitors())
                        text.append("  locked monitor ").append(lock).append('\n');
                    for (var lock : info.getLockedSynchronizers())
                        text.append("  locked synchronizer ").append(lock).append('\n');
                    text.append('\n');
                }
                long[] deadlocked = ManagementFactory.getThreadMXBean().findDeadlockedThreads();
                if (deadlocked != null) text.append("Deadlocked thread IDs: ").append(
                    Arrays.toString(deadlocked)
                );
                Files.writeString(artifacts.resolve(name), text);
            } else if (c.getProperty("type").equals("allocations")) {
                if (recording == null) throw new IllegalStateException("JFR unavailable");
                Path snapshot = Files.createTempFile(artifacts, "allocation-snapshot-", ".jfr");
                try {
                    recording.dump(snapshot);
                    var report = AllocationReport.read(
                        snapshot,
                        c.getProperty("packagePrefix", ""),
                        Integer.parseInt(c.getProperty("windowSeconds", "30")),
                        Integer.parseInt(c.getProperty("limit", "20"))
                    );
                    name = "allocations-" + c.getProperty("id") + ".txt";
                    Files.writeString(artifacts.resolve(name), Json.encode(report));
                } finally {
                    Files.deleteIfExists(snapshot);
                }
            } else {
                if (recording == null) throw new IllegalStateException("JFR unavailable");
                name = "recording-" + System.currentTimeMillis() + ".jfr";
                recording.dump(artifacts.resolve(name));
            }
            complete(c, true, Map.of("artifact", name));
        } catch (Exception e) {
            complete(c, false, Map.of("error", e.toString()));
        }
    }

    void async(Runnable job) {
        io.execute(job);
    }
}
