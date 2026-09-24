package io.modlens.runtime.legacy;

import java.io.*;
import java.lang.instrument.Instrumentation;
import java.lang.management.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** Java 8-compatible JVM diagnostics for Minecraft versions without the SDL adapter. */
public final class LegacyAgent {
    private final Path config;
    final Path artifacts;
    private final String sessionId = UUID.randomUUID().toString();
    private final long startedAt = System.currentTimeMillis();
    private final Deque<Map<String, Object>> events = new ArrayDeque<Map<String, Object>>();
    private final Deque<Map<String, Object>> results = new ArrayDeque<Map<String, Object>>();
    private final Set<String> received = new LinkedHashSet<String>();
    private long sequence;
    private long lastSample, lastGc, lastPressure;
    private int pressureSamples;
    volatile long lastConnected = System.currentTimeMillis();

    final LegacyInput input;
    private JfrSupport jfr;

    public static void start(String path, Instrumentation instrumentation) {
        try {
            if (path == null || path.length() == 0) throw new IllegalArgumentException("Missing connection.properties path");
            final LegacyAgent agent = new LegacyAgent(Paths.get(path));
            LegacyHooks.handler = agent.input;
            instrumentation.addTransformer(new LegacyTransformer(agent));
            agent.startJfr();
            final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
            Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
                public void uncaughtException(Thread thread, Throwable error) {
                    agent.failure(thread, error);
                    if (previous != null) previous.uncaughtException(thread, error);
                    else error.printStackTrace();
                }
            });
            agent.event("agent_started", map("javaVersion", System.getProperty("java.version"), "target", agent.configuration().getProperty("mcVersion")));
            Runtime.getRuntime().addShutdownHook(new Thread(new Runnable() {
                public void run() {
                    agent.event("jvm_shutdown", Collections.<String, Object>emptyMap());
                    try { agent.exchange(); } catch (Exception ignored) { }
                    if (agent.jfr != null) agent.jfr.close();
                }
            }, "ModLens shutdown"));
            Thread worker = new Thread(new Runnable() {
                public void run() { agent.loop(); }
            }, "ModLens telemetry");
            worker.setDaemon(true);
            worker.start();
        } catch (Throwable error) {
            System.err.println("[ModLens] Legacy agent disabled: " + error);
        }
    }

    private LegacyAgent(Path config) throws IOException {
        this.config = config.toAbsolutePath();
        this.artifacts = this.config.getParent().resolve("sessions").resolve(sessionId);
        Files.createDirectories(artifacts);
        Properties p = configuration();
        URI endpoint = URI.create(p.getProperty("endpoint", ""));
        if (!"http".equals(endpoint.getScheme()) || !"127.0.0.1".equals(endpoint.getHost()) || endpoint.getUserInfo() != null)
            throw new IOException("Runtime bridge must be loopback HTTP");
        input = new LegacyInput(this, p.getProperty("mode", "interactive"));
    }

    private void startJfr() {
        try {
            jfr = (JfrSupport) Class.forName("io.modlens.runtime.legacy.LegacyJfr")
                .getConstructor().newInstance();
        } catch (Throwable unavailable) {
            event("jfr_unavailable", map("reason", unavailable.toString(),
                "cause", unavailable.getCause() == null ? "" : unavailable.getCause().toString()));
        }
    }

    private Properties configuration() throws IOException {
        Properties p = new Properties();
        InputStream in = Files.newInputStream(config);
        try { p.load(in); } finally { in.close(); }
        return p;
    }

    synchronized void event(String type, Map<String, Object> data) {
        events.addLast(map("seq", ++sequence, "time", System.currentTimeMillis(), "type", type, "data", data));
        while (events.size() > 256) events.removeFirst();
    }

    synchronized void complete(String id, boolean ok, Map<String, Object> data) {
        results.addLast(map("id", id, "ok", ok, "data", data));
        while (results.size() > 20) results.removeFirst();
    }

    void failure(Thread thread, Throwable error) {
        try {
            StringWriter buffer = new StringWriter();
            error.printStackTrace(new PrintWriter(buffer));
            String trace = buffer.toString();
            if (trace.length() > 24000) trace = trace.substring(0, 24000);
            String name = "failure-" + System.currentTimeMillis() + ".txt";
            Files.write(artifacts.resolve(name), trace.getBytes(StandardCharsets.UTF_8));
            event("uncaught_exception", map("thread", thread.getName(), "exception", error.getClass().getName(), "stack", trace, "artifact", name));
        } catch (Throwable ignored) { }
    }

    private void loop() {
        while (true) {
            try {
                exchange();
                Thread.sleep(250);
            } catch (InterruptedException stop) {
                return;
            } catch (Exception unavailable) {
                try { Thread.sleep(1000); } catch (InterruptedException stop) { return; }
            }
        }
    }

    private synchronized void exchange() throws Exception {
        Properties p = configuration();
        URI endpoint = URI.create(p.getProperty("endpoint"));
        if (!"http".equals(endpoint.getScheme()) || !"127.0.0.1".equals(endpoint.getHost()) || endpoint.getUserInfo() != null)
            throw new IOException("Runtime bridge must be loopback HTTP");
        List<Map<String, Object>> batch = new ArrayList<Map<String, Object>>();
        for (Map<String, Object> e : events) {
            if (batch.size() == 2) break;
            batch.add(e);
        }
        List<Map<String, Object>> completed = new ArrayList<Map<String, Object>>(results);
        Runtime runtime = Runtime.getRuntime();
        MemoryUsage heap = ManagementFactory.getMemoryMXBean().getHeapMemoryUsage();
        long now = System.currentTimeMillis();
        long gcTime = 0;
        long gcCount = 0;
        for (GarbageCollectorMXBean gc : ManagementFactory.getGarbageCollectorMXBeans()) {
            gcTime += Math.max(0, gc.getCollectionTime());
            gcCount += Math.max(0, gc.getCollectionCount());
        }
        double gcRatio = lastSample == 0 ? 0 : Math.max(0, (gcTime - lastGc) / (double) (now - lastSample));
        Map<String, Object> metrics = map(
            "time", now, "heapUsed", heap.getUsed(),
            "heapCommitted", heap.getCommitted(), "heapMax", heap.getMax(),
            "threads", ManagementFactory.getThreadMXBean().getThreadCount(),
            "processors", runtime.availableProcessors(), "gcCount", gcCount,
            "gcTimeMs", gcTime, "gcCollectionTimeRatio", gcRatio,
            "nonHeapUsed", ManagementFactory.getMemoryMXBean().getNonHeapMemoryUsage().getUsed());
        if (gcRatio > 0.2 && heap.getMax() > 0 && heap.getUsed() > heap.getMax() * 0.8) pressureSamples++;
        else pressureSamples = 0;
        if (pressureSamples >= 3 && now - lastPressure > 30000) {
            lastPressure = now;
            event("memory_pressure", metrics);
        }
        lastSample = now;
        lastGc = gcTime;
        Map<String, Object> capabilities = input.capabilities(p.getProperty("mcVersion", "unknown"), jfr != null);
        Map<String, Object> packet = map(
            "protocol", 1, "sessionId", sessionId, "pid", pid(), "startedAt", startedAt,
            "javaVersion", System.getProperty("java.version"), "capabilities", capabilities,
            "state", input.state(), "metrics", metrics,
            "events", batch, "results", completed);
        byte[] bytes = json(packet).getBytes(StandardCharsets.UTF_8);
        HttpURLConnection connection = (HttpURLConnection) endpoint.toURL().openConnection();
        connection.setConnectTimeout(1000);
        connection.setReadTimeout(1000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setRequestProperty("Authorization", "Bearer " + p.getProperty("token"));
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setFixedLengthStreamingMode(bytes.length);
        try {
            OutputStream out = connection.getOutputStream();
            try { out.write(bytes); } finally { out.close(); }
            if (connection.getResponseCode() != 200) throw new IOException("Bridge unavailable");
            lastConnected = System.currentTimeMillis();
            Properties response = new Properties();
            InputStream in = connection.getInputStream();
            try { response.load(in); } finally { in.close(); }
            long ack = Long.parseLong(response.getProperty("ack", "0"));
            while (!events.isEmpty() && ((Number) events.peekFirst().get("seq")).longValue() <= ack) events.removeFirst();
            results.removeAll(completed);
            String id = response.getProperty("id");
            if (id != null && received.add(id)) {
                if (received.size() > 256) received.remove(received.iterator().next());
                command(response);
            }
        } finally {
            connection.disconnect();
        }
    }

    private void command(Properties p) {
        String id = p.getProperty("id");
        String type = p.getProperty("type", "");
        if (Long.parseLong(p.getProperty("deadline", "0")) < System.currentTimeMillis()) {
            complete(id, false, map("error", "Command expired"));
            return;
        }
        if (!"threads".equals(type)) {
            if (("recording".equals(type) || "allocations".equals(type)) && jfr != null) {
                jfr.command(p, this);
                return;
            }
            if (input.offer(p)) return;
            complete(id, false, map("error", type + " is unavailable on the legacy JVM monitoring agent"));
            return;
        }
        try {
            String name = "threads-" + id + ".txt";
            StringBuilder text = new StringBuilder();
            for (Map.Entry<Thread, StackTraceElement[]> entry : Thread.getAllStackTraces().entrySet()) {
                if (text.length() > 1000000) break;
                text.append('"').append(entry.getKey().getName()).append("\" ").append(entry.getKey().getState()).append('\n');
                for (StackTraceElement frame : entry.getValue()) text.append("    at ").append(frame).append('\n');
                text.append('\n');
            }
            Files.write(artifacts.resolve(name), text.toString().getBytes(StandardCharsets.UTF_8));
            complete(id, true, map("artifact", name));
        } catch (Exception error) {
            complete(id, false, map("error", error.toString()));
        }
    }

    private static long pid() {
        String name = ManagementFactory.getRuntimeMXBean().getName();
        try { return Long.parseLong(name.substring(0, name.indexOf('@'))); }
        catch (Exception ignored) { return Math.max(1, Thread.currentThread().getId()); }
    }

    static Map<String, Object> map(Object... pairs) {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        for (int i = 0; i < pairs.length; i += 2) result.put((String) pairs[i], pairs[i + 1]);
        return result;
    }

    static String json(Object value) {
        if (value == null) return "null";
        if (value instanceof Number || value instanceof Boolean) return value.toString();
        if (value instanceof Map) {
            StringBuilder out = new StringBuilder("{");
            for (Object item : ((Map<?, ?>) value).entrySet()) {
                Map.Entry<?, ?> entry = (Map.Entry<?, ?>) item;
                if (out.length() > 1) out.append(',');
                out.append(json(entry.getKey().toString())).append(':').append(json(entry.getValue()));
            }
            return out.append('}').toString();
        }
        if (value instanceof Iterable) {
            StringBuilder out = new StringBuilder("[");
            for (Object item : (Iterable<?>) value) {
                if (out.length() > 1) out.append(',');
                out.append(json(item));
            }
            return out.append(']').toString();
        }
        StringBuilder out = new StringBuilder("\"");
        for (char c : value.toString().toCharArray()) {
            if (c == '"' || c == '\\') out.append('\\').append(c);
            else if (c == '\n') out.append("\\n");
            else if (c == '\r') out.append("\\r");
            else if (c == '\t') out.append("\\t");
            else if (c < 32) out.append(String.format("\\u%04x", (int) c));
            else out.append(c);
        }
        return out.append('"').toString();
    }
}
