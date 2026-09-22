package io.modlens.runtime;

import java.nio.file.Path;
import java.time.Instant;
import java.util.*;
import jdk.jfr.consumer.*;

/** Sample weights indicate allocation pressure, never live/retained object sizes. */
final class AllocationReport {

    private static final class Hotspot {

        final String site, allocatedClass;
        final List<String> stack;
        long samples, weight;

        Hotspot(String site, String allocatedClass, List<String> stack) {
            this.site = site;
            this.allocatedClass = allocatedClass;
            this.stack = stack;
        }

        Map<String, Object> view() {
            return Map.of(
                "site",
                site,
                "allocatedClass",
                allocatedClass,
                "samples",
                samples,
                "sampleWeightBytes",
                weight,
                "exampleStack",
                stack
            );
        }
    }

    static Map<String, Object> read(Path path, String prefix, int seconds, int limit) throws Exception {
        Instant end = Instant.now(),
            start = end.minusSeconds(seconds);
        Map<String, Hotspot> groups = new HashMap<>();
        long samples = 0,
            matched = 0,
            totalWeight = 0,
            matchedWeight = 0;
        boolean capped = false;
        // Package boundaries avoid matching com.example.modification for com.example.mod.
        String packageName = prefix.endsWith(".") ? prefix.substring(0, prefix.length() - 1) : prefix;
        try (RecordingFile file = new RecordingFile(path)) {
            while (file.hasMoreEvents()) {
                RecordedEvent event = file.readEvent();
                if (
                    !event.getEventType().getName().equals("jdk.ObjectAllocationSample") ||
                    event.getStartTime().isBefore(start)
                ) continue;
                long weight = event.getLong("weight");
                samples++;
                totalWeight += weight;
                RecordedStackTrace trace = event.getStackTrace();
                List<RecordedFrame> frames = trace == null ? List.of() : trace.getFrames();
                RecordedFrame chosen = null;
                for (RecordedFrame frame : frames) {
                    String owner = frame.getMethod().getType().getName();
                    if (
                        packageName.isEmpty() ||
                        owner.equals(packageName) ||
                        owner.startsWith(packageName + ".")
                    ) {
                        chosen = frame;
                        break;
                    }
                }
                if (chosen == null && !packageName.isEmpty()) continue;
                matched++;
                matchedWeight += weight;
                String site = chosen == null ? "<stack unavailable>" : frameName(chosen);
                var type = event.getClass("objectClass");
                String allocatedClass = type == null ? "<unknown>" : type.getName();
                String key = site + "\n" + allocatedClass;
                Hotspot hotspot = groups.get(key);
                if (hotspot == null) {
                    if (groups.size() >= 4096) {
                        capped = true;
                        continue;
                    }
                    hotspot = new Hotspot(
                        site,
                        allocatedClass,
                        frames.stream().limit(12).map(AllocationReport::frameName).toList()
                    );
                    groups.put(key, hotspot);
                }
                hotspot.samples++;
                hotspot.weight += weight;
            }
        }
        var report = new LinkedHashMap<String, Object>();
        report.put("kind", "sampled_allocation_pressure");
        report.put("requestedWindowSeconds", seconds);
        report.put("packagePrefix", prefix);
        report.put("samples", samples);
        report.put("matchedSamples", matched);
        report.put("sampleWeightBytes", totalWeight);
        report.put("matchedSampleWeightBytes", matchedWeight);
        report.put("groupLimitReached", capped);
        report.put(
            "hotspots",
            groups
                .values()
                .stream()
                .sorted(Comparator.comparingLong((Hotspot h) -> h.weight).reversed())
                .limit(limit)
                .map(Hotspot::view)
                .toList()
        );
        report.put(
            "interpretation",
            "JFR weighted samples estimate allocation pressure, not exact byte counts, retained heap, or proof of a leak. The site is the first matching caller in the sampled stack; library allocations may be attributed to that caller. Empty results do not prove absence of allocations. The rolling recording can contain less history than the requested window."
        );
        return report;
    }

    private static String frameName(RecordedFrame frame) {
        var method = frame.getMethod();
        return method.getType().getName() + "." + method.getName() + ":" + frame.getLineNumber();
    }
}
