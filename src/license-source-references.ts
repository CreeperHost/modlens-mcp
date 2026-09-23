/** Reviewed release-to-source associations for upstreams without release tags.
 * These supply provenance, never a licence override. The resolver still reads
 * the licence and notices at the immutable commit and checks the artifact.
 * Add entries only after reviewing the upstream release/version evidence.
 */
export const reviewedSourceReferences: Record<string, { repository: string; commit: string; version: string; evidence: string }> = {
    // Published artifact: https://modrinth.com/mod/embeddium/version/UTbfe5d1
    // Upstream's release commit is titled "0.3.31"; gradle.properties declares
    // mod_version=0.3.31 and minecraft_version=1.20.1. Its timestamp is 23s
    // after publication, so a "latest commit before upload" heuristic is wrong.
    "eed3d1325f2acc2fd4e69bb495e5ccb91d962126ac5330f0582ebc2a3daf47fb": {
        repository: "FiniteReality/embeddium",
        commit: "87d1a75aecc230a25a1c152df8fbd7d2ca8bd2fd",
        version: "0.3.31+mc1.20.1",
        evidence: "https://github.com/FiniteReality/embeddium/commit/87d1a75aecc230a25a1c152df8fbd7d2ca8bd2fd",
    },
};
