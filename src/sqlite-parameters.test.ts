import { expect, it } from "vitest";
import { sqliteRawArgs } from "./sqlite-parameters.js";
it("reorders/repeats positional bindings while preserving SQL literals and comments", () => {
    expect(sqliteRawArgs(["SELECT '$1', \"$2\" FROM t WHERE a=$2 OR b=$1 OR c=$2 -- $9\n", "first", "second"]))
        .toEqual(["SELECT '$1', \"$2\" FROM t WHERE a=? OR b=? OR c=? -- $9\n", "second", "first", "second"]);
});
