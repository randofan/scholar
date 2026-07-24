import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "./citations.server";
import {
  fetchArxivPaper,
  fetchSemanticScholarPaper,
  parseArxivEntry,
  parseArxivFeed,
  resolveReference,
  searchArxivByTitle,
  searchSemanticScholarByTitle,
} from "./citations.server";

const ARXIV_ENTRY = `
  <entry>
    <id>http://arxiv.org/abs/1901.01234v2</id>
    <updated>2019-01-05T00:00:00Z</updated>
    <published>2019-01-03T00:00:00Z</published>
    <title>Random number generation using expander graphs</title>
    <summary>  We present a new method for random number generation
 using expander graphs. The method achieves high throughput.
</summary>
    <author><name>A. Author</name></author>
    <author><name>B. Coauthor</name></author>
  </entry>
`;

const ARXIV_ERROR_ENTRY = `
  <entry>
    <id>http://arxiv.org/api/errors#incorrect_id_format_for_9999.99999</id>
    <title>Error</title>
    <summary>incorrect id format for 9999.99999</summary>
  </entry>
`;

function arxivFeed(entries: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${entries.join("")}</feed>`;
}

describe("parseArxivEntry", () => {
  it("parses a well-formed entry into a ResolvedPaper", () => {
    const paper = parseArxivEntry(ARXIV_ENTRY);
    expect(paper).toEqual({
      title: "Random number generation using expander graphs",
      abstract:
        "We present a new method for random number generation using expander graphs. The method achieves high throughput.",
      authors: ["A. Author", "B. Coauthor"],
      year: 2019,
      url: "http://arxiv.org/abs/1901.01234v2",
      source: "arxiv",
    });
  });

  it("returns null for the API's own error entry (invalid id_list lookup)", () => {
    expect(parseArxivEntry(ARXIV_ERROR_ENTRY)).toBeNull();
  });

  it("returns null when there's no title", () => {
    expect(parseArxivEntry("<entry><id>http://arxiv.org/abs/1.1</id></entry>")).toBeNull();
  });
});

describe("parseArxivFeed", () => {
  it("parses every entry in a multi-entry feed", () => {
    const feed = arxivFeed([ARXIV_ENTRY, ARXIV_ENTRY]);
    expect(parseArxivFeed(feed)).toHaveLength(2);
  });

  it("returns [] for a feed with no entries", () => {
    expect(parseArxivFeed(arxivFeed([]))).toEqual([]);
  });

  it("skips error entries but keeps real ones", () => {
    const feed = arxivFeed([ARXIV_ERROR_ENTRY, ARXIV_ENTRY]);
    const papers = parseArxivFeed(feed);
    expect(papers).toHaveLength(1);
    expect(papers[0].title).toBe("Random number generation using expander graphs");
  });
});

describe("fetchArxivPaper", () => {
  it("fetches by id_list and returns the parsed paper", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      expect(url).toContain("id_list=1901.01234");
      return new Response(arxivFeed([ARXIV_ENTRY]));
    });
    const paper = await fetchArxivPaper("1901.01234", fetchImpl);
    expect(paper?.title).toBe("Random number generation using expander graphs");
  });

  it("returns null on a non-OK response instead of throwing", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response("", { status: 503 }));
    expect(await fetchArxivPaper("1901.01234", fetchImpl)).toBeNull();
  });

  it("returns null when the network call throws", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new Error("network down");
    });
    expect(await fetchArxivPaper("1901.01234", fetchImpl)).toBeNull();
  });

  it("returns null for an id arXiv reports as invalid", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response(arxivFeed([ARXIV_ERROR_ENTRY])));
    expect(await fetchArxivPaper("9999.99999", fetchImpl)).toBeNull();
  });
});

describe("searchArxivByTitle", () => {
  it("builds a title search query and returns the first result", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      expect(url).toContain("search_query=");
      expect(decodeURIComponent(url)).toContain(
        'ti:"Random number generation using expander graphs"',
      );
      return new Response(arxivFeed([ARXIV_ENTRY]));
    });
    const paper = await searchArxivByTitle(
      "Random number generation using expander graphs",
      fetchImpl,
    );
    expect(paper?.source).toBe("arxiv");
  });

  it("returns null when nothing matches", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response(arxivFeed([])));
    expect(await searchArxivByTitle("Some Unfindable Title", fetchImpl)).toBeNull();
  });
});

describe("fetchSemanticScholarPaper", () => {
  it("resolves via arXiv-ID lookup and maps the JSON shape", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      expect(url).toContain("/paper/arXiv:1901.01234");
      return Response.json({
        title: "Random number generation using expander graphs",
        abstract: "We present a new method.",
        year: 2019,
        authors: [{ name: "A. Author" }, { name: "B. Coauthor" }],
        url: "https://www.semanticscholar.org/paper/abc123",
      });
    });
    const paper = await fetchSemanticScholarPaper("1901.01234", fetchImpl);
    expect(paper).toEqual({
      title: "Random number generation using expander graphs",
      abstract: "We present a new method.",
      authors: ["A. Author", "B. Coauthor"],
      year: 2019,
      url: "https://www.semanticscholar.org/paper/abc123",
      source: "semantic-scholar",
    });
  });

  it("returns null on a 404 (paper not indexed) instead of throwing", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response("Not Found", { status: 404 }));
    expect(await fetchSemanticScholarPaper("0000.00000", fetchImpl)).toBeNull();
  });

  it("treats a null abstract as absent rather than the literal string 'null'", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      Response.json({ title: "Some Paper", abstract: null }),
    );
    const paper = await fetchSemanticScholarPaper("1234.56789", fetchImpl);
    expect(paper?.abstract).toBeUndefined();
  });
});

describe("searchSemanticScholarByTitle", () => {
  it("returns the first search result", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      expect(url).toContain("/paper/search?query=");
      return Response.json({
        data: [{ title: "Fat-tree topologies for datacenter networks", year: 2015 }],
      });
    });
    const paper = await searchSemanticScholarByTitle("Fat-tree topologies", fetchImpl);
    expect(paper?.title).toBe("Fat-tree topologies for datacenter networks");
  });

  it("returns null when the search has no results", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => Response.json({ data: [] }));
    expect(await searchSemanticScholarByTitle("Nothing matches this", fetchImpl)).toBeNull();
  });
});

describe("resolveReference", () => {
  it("prefers Semantic Scholar over arXiv for an arXiv-ID reference", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (String(url).includes("semanticscholar")) {
        return Response.json({ title: "From Semantic Scholar", abstract: "abstract text" });
      }
      throw new Error("arXiv should not be called when Semantic Scholar succeeds");
    });
    const paper = await resolveReference({ arxivId: "1901.01234" }, fetchImpl);
    expect(paper?.title).toBe("From Semantic Scholar");
    expect(paper?.source).toBe("semantic-scholar");
  });

  it("falls back to arXiv's own API when Semantic Scholar has no record of the arXiv ID", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (String(url).includes("semanticscholar"))
        return new Response("Not Found", { status: 404 });
      return new Response(arxivFeed([ARXIV_ENTRY]));
    });
    const paper = await resolveReference({ arxivId: "1901.01234" }, fetchImpl);
    expect(paper?.source).toBe("arxiv");
  });

  it("falls back to a title search when there is no arXiv ID", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      expect(String(url)).toContain("/paper/search?query=");
      return Response.json({ data: [{ title: "Found by title" }] });
    });
    const paper = await resolveReference({ titleGuess: "Some paper title" }, fetchImpl);
    expect(paper?.title).toBe("Found by title");
  });

  it("returns null without making any request when neither an arXiv ID nor a title guess is available", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    expect(await resolveReference({}, fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when every source comes up empty", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (String(url).includes("semanticscholar")) return new Response("", { status: 404 });
      return new Response(arxivFeed([]));
    });
    expect(
      await resolveReference({ arxivId: "1901.01234", titleGuess: "Untitled" }, fetchImpl),
    ).toBeNull();
  });
});
