import { describe, expect, test } from "bun:test";
import { legacyRepoRedirect, repoPath, serveMounts } from "./repo-route";

describe("repository URLs", () => {
  test("tailnet mounts restore both internal paths without claiming the origin", () => {
    expect(serveMounts("/webcode", 3001)).toEqual([
      { mount: "/webcode", target: "http://127.0.0.1:3001/webcode/" },
      { mount: "/gh", target: "http://127.0.0.1:3001/webcode/gh" },
    ]);
    expect(serveMounts("/", 3001)).toHaveLength(1);
    expect(serveMounts("/gh", 3001)).toEqual([{ mount: "/gh", target: "http://127.0.0.1:3001/gh/" }]);
  });
  test("short links work with both local and mounted assets", () => {
    for (const base of ["/", "/webcode/"]) {
      expect(repoPath("/gh/owner/repo/tree/feature%2Fbranch", base)).toBe("owner/repo/tree/feature/branch");
      expect(repoPath(`${base}github.com/owner/repo/tree/main`, base)).toBe("owner/repo/tree/main");
      expect(repoPath(`${base}owner/repo/tree/main`, base)).toBe("owner/repo/tree/main");
      expect(repoPath("/gh/", base)).toBe("");
    }
  });

  test("legacy redirects preserve encoded branches and query parameters", () => {
    expect(legacyRepoRedirect("/webcode/owner/repo/tree/main", "/webcode/"))
      .toBe("/gh/owner/repo/tree/main");
    expect(legacyRepoRedirect("/webcode/owner/repo/tree/feature/a%2Fb?ui=wtx", "/webcode/"))
      .toBe("/gh/owner/repo/tree/feature/a%2Fb?ui=wtx");
    expect(legacyRepoRedirect("/owner/repo/tree/main", "/"))
      .toBe("/gh/owner/repo/tree/main");
    expect(legacyRepoRedirect("/gh/owner/repo/tree/main", "/gh/"))
      .toBeNull();
    expect(legacyRepoRedirect("/webcode/github.com/owner/repo/tree/a%2Fb?ui=wtx", "/webcode/"))
      .toBe("/gh/owner/repo/tree/a%2Fb?ui=wtx");
    expect(legacyRepoRedirect("/github.com/owner/repo/tree/main", "/webcode/"))
      .toBe("/gh/owner/repo/tree/main");
    for (const url of ["/gh/owner/repo/tree/main", "/webcode/api/repo/owner/repo/tree/main", "/webcode/api/repo/tree/main", "/webcode/assets/repo/tree/main", "/webcode/owner/repo/tree/", "/webcode/_wtx/", "/github.com.evil/owner/repo"]) {
      expect(legacyRepoRedirect(url, "/webcode/")).toBeNull();
    }
  });
});
