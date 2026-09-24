import { describe, expect, it } from "vitest";
import { isRfc1918Peer } from "./private-network.js";

describe("RFC 1918 HTTP access", () => {
    it("accepts only the three RFC 1918 IPv4 ranges, including IPv4-mapped peers", () => {
        for (const address of ["10.0.0.0", "10.255.255.255", "172.16.0.0", "172.31.255.255",
            "192.168.0.0", "192.168.255.255", "::ffff:192.168.1.12"]) {
            expect(isRfc1918Peer(address, {}, {}), address).toBe(true);
        }
        for (const address of [undefined, "127.0.0.1", "169.254.1.1", "172.15.255.255",
            "172.32.0.0", "192.167.1.1", "192.169.0.1", "100.64.1.1", "8.8.8.8",
            "::1", "fc00::1", "::ffff:8.8.8.8", "10.0.0.1:1234", "10.0.0.999"]) {
            expect(isRfc1918Peer(address, {}, {}), String(address)).toBe(false);
        }
    });

    it("honors the opt-out and keeps forwarded or gateway traffic on hosted access", () => {
        expect(isRfc1918Peer("10.1.2.3", {}, { MODLENS_RFC1918_BYPASS: "0" })).toBe(false);
        for (const header of ["forwarded", "x-forwarded-for", "x-real-ip",
            "x-modlens-proxy-secret", "x-modlens-user-id"]) {
            expect(isRfc1918Peer("10.1.2.3", { [header]: "peer" }, {}), header).toBe(false);
        }
    });
});
