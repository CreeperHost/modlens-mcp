package io.modlens.runtime.legacy;

import java.util.Properties;

interface JfrSupport extends AutoCloseable {
    void command(Properties command, LegacyAgent agent);
    void close();
}
