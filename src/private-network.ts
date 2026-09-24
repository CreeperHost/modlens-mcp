import { isIP } from "node:net";
import type { IncomingHttpHeaders } from "node:http";

/** Trust only the direct TCP peer. Forwarded requests must use normal hosted authentication. */
export function isRfc1918Peer(address: string | undefined, headers: IncomingHttpHeaders,
    env: NodeJS.ProcessEnv = process.env): boolean {
    if (env.MODLENS_RFC1918_BYPASS === "0" || !address) return false;
    if (headers.forwarded !== undefined || headers["x-forwarded-for"] !== undefined
        || headers["x-real-ip"] !== undefined || headers["x-modlens-proxy-secret"] !== undefined
        || headers["x-modlens-user-id"] !== undefined) return false;

    const ipv4 = address.startsWith("::ffff:") ? address.slice(7) : address;
    if (isIP(ipv4) !== 4) return false;
    const [first, second] = ipv4.split(".").map(Number);
    return first === 10 || first === 172 && second >= 16 && second <= 31
        || first === 192 && second === 168;
}
