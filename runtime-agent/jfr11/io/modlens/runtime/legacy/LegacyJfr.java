package io.modlens.runtime.legacy;

import java.nio.file.*;
import java.time.*;
import java.util.*;
import jdk.jfr.Recording;
import jdk.jfr.consumer.*;

/** Loaded reflectively only when the target JVM provides JFR. */
public final class LegacyJfr implements JfrSupport {
    private final Recording recording;

    public LegacyJfr() {
        recording = new Recording();
        recording.setName("ModLens rolling diagnostics");
        recording.setMaxAge(Duration.ofMinutes(2));
        recording.setMaxSize(16 * 1024 * 1024);
        recording.enable("jdk.GarbageCollection");
        recording.enable("jdk.GCHeapSummary");
        recording.enable("jdk.JavaErrorThrow");
        recording.enable("jdk.CPULoad").withPeriod(Duration.ofSeconds(1));
        recording.enable("jdk.ObjectAllocationSample").withStackTrace();
        recording.start();
    }

    public void command(Properties command, LegacyAgent agent) {
        String id = command.getProperty("id");
        try {
            if (command.getProperty("type").equals("recording")) {
                String name = "recording-" + id + ".jfr";
                recording.dump(agent.artifacts.resolve(name));
                agent.complete(id, true, LegacyAgent.map("artifact", name));
                return;
            }
            Path snapshot = Files.createTempFile(agent.artifacts, "allocation-snapshot-", ".jfr");
            try {
                recording.dump(snapshot);
                String prefix = command.getProperty("packagePrefix", "");
                int seconds = Integer.parseInt(command.getProperty("windowSeconds", "30"));
                int limit = Integer.parseInt(command.getProperty("limit", "20"));
                Map<String, Object> report = allocations(snapshot, prefix, seconds, limit);
                String name = "allocations-" + id + ".txt";
                Files.write(agent.artifacts.resolve(name), LegacyAgent.json(report).getBytes(java.nio.charset.StandardCharsets.UTF_8));
                agent.complete(id, true, LegacyAgent.map("artifact", name));
            } finally { Files.deleteIfExists(snapshot); }
        } catch (Exception error) {
            agent.complete(id, false, LegacyAgent.map("error", error.toString()));
        }
    }

    private static Map<String, Object> allocations(Path path, String prefix, int seconds, int limit) throws Exception {
        Instant start = Instant.now().minusSeconds(seconds);
        String packageName = prefix.endsWith(".") ? prefix.substring(0, prefix.length() - 1) : prefix;
        Map<String, Hotspot> groups = new HashMap<String, Hotspot>();
        long samples = 0, matched = 0, totalWeight = 0, matchedWeight = 0;
        boolean capped = false;
        try (RecordingFile file = new RecordingFile(path)) {
            while (file.hasMoreEvents()) {
                RecordedEvent event = file.readEvent();
                if (!event.getEventType().getName().equals("jdk.ObjectAllocationSample") ||
                    event.getStartTime().isBefore(start)) continue;
                long weight = event.getLong("weight");
                samples++;
                totalWeight += weight;
                RecordedStackTrace stack = event.getStackTrace();
                List<RecordedFrame> frames = stack == null ? Collections.<RecordedFrame>emptyList() : stack.getFrames();
                RecordedFrame chosen = null;
                for (RecordedFrame frame : frames) {
                    String owner = frame.getMethod().getType().getName();
                    if (packageName.isEmpty() || owner.equals(packageName) || owner.startsWith(packageName + ".")) {
                        chosen = frame;
                        break;
                    }
                }
                if (chosen == null && !packageName.isEmpty()) continue;
                matched++;
                matchedWeight += weight;
                String site = chosen == null ? "<stack unavailable>" : name(chosen);
                Object allocated = event.getValue("objectClass");
                String allocatedClass = allocated instanceof RecordedClass ? ((RecordedClass) allocated).getName() : "<unknown>";
                String key = site + "\n" + allocatedClass;
                Hotspot hotspot = groups.get(key);
                if (hotspot == null) {
                    if (groups.size() >= 4096) { capped = true; continue; }
                    List<String> example = new ArrayList<String>();
                    for (RecordedFrame frame : frames) {
                        if (example.size() == 12) break;
                        example.add(name(frame));
                    }
                    hotspot = new Hotspot(site, allocatedClass, example);
                    groups.put(key, hotspot);
                }
                hotspot.samples++;
                hotspot.weight += weight;
            }
        }
        List<Hotspot> sorted = new ArrayList<Hotspot>(groups.values());
        Collections.sort(sorted, new Comparator<Hotspot>() {
            public int compare(Hotspot left, Hotspot right) { return Long.compare(right.weight, left.weight); }
        });
        List<Map<String, Object>> hotspots = new ArrayList<Map<String, Object>>();
        for (Hotspot hotspot : sorted) {
            if (hotspots.size() >= limit) break;
            hotspots.add(hotspot.view());
        }
        return LegacyAgent.map("kind", "sampled_allocation_pressure", "requestedWindowSeconds", seconds,
            "packagePrefix", prefix, "samples", samples, "matchedSamples", matched,
            "sampleWeightBytes", totalWeight, "matchedSampleWeightBytes", matchedWeight,
            "groupLimitReached", capped, "hotspots", hotspots,
            "interpretation", "JFR weighted samples estimate allocation pressure, not retained heap or proof of a leak.");
    }

    private static String name(RecordedFrame frame) {
        return frame.getMethod().getType().getName() + "." + frame.getMethod().getName() + ":" + frame.getLineNumber();
    }

    private static final class Hotspot {
        final String site, allocatedClass;
        final List<String> stack;
        long samples, weight;
        Hotspot(String site, String allocatedClass, List<String> stack) {
            this.site = site; this.allocatedClass = allocatedClass; this.stack = stack;
        }
        Map<String, Object> view() {
            return LegacyAgent.map("site", site, "allocatedClass", allocatedClass,
                "samples", samples, "sampleWeightBytes", weight, "exampleStack", stack);
        }
    }

    public void close() { recording.close(); }
}
