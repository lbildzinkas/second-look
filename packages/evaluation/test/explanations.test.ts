import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { changeText, explainChecks, reviewChange, type ExplainAnswer } from '@second-look/engine';
import { caseInput, loadCases } from '../src/case.js';
import { labelledPart } from '../src/score.js';

const CASES = fileURLToPath(new URL('../cases', import.meta.url));

/**
 * An explanation written by hand of one of the cases' labelled parts,
 * with what a reviewer says of it: whether every line it cites is one the
 * part shows, with its quote, and whether it names only what the change
 * shows. The plain checks must agree with every label before their scores
 * are trusted (ADR 0006).
 */
interface LabelledExplanation {
  case: string;
  /** The part, as the case's `explain` names it. */
  part: string;
  answer: ExplainAnswer;
  citesPart: boolean;
  namesInChange: boolean;
}

const LABELLED: readonly LabelledExplanation[] = [
  {
    case: 'canary-python',
    part: 'doc_page in app/doc_links.py',
    answer: {
      does: '`doc_page` gets the page at `url` with `client.get`, raises on an error status and returns the text.',
      matters: 'It is the whole change: the new helper its docstring describes.',
      cited: [
        { file: 'app/doc_links.py', side: 'head', line: 12, quote: 'response = client.get(url)' },
        { file: 'app/doc_links.py', side: 'head', line: 14, quote: 'return response.text' },
      ],
    },
    citesPart: true,
    namesInChange: true,
  },
  {
    case: 'canary-python',
    part: 'doc_page in app/doc_links.py',
    answer: {
      does: '`doc_page` follows redirects because `httpx.Client` sets `follow_redirects` for it.',
      matters: 'Callers get the final page.',
      cited: [{ file: 'app/doc_links.py', side: 'head', line: 15, quote: 'return response.text' }],
    },
    citesPart: false,
    namesInChange: false,
  },
  {
    case: 'canary-csharp',
    part: 'BlobReader, BlobReader.Read in src/BlobReader.cs',
    answer: {
      does: '`Read` copies `input` into a pooled `stream` and returns `GetBuffer()`.',
      matters: 'It is the one entry point the change adds for reading a blob.',
      cited: [{ file: 'src/BlobReader.cs', side: 'head', line: 18, quote: 'return stream.GetBuffer();' }],
    },
    citesPart: true,
    namesInChange: true,
  },
  {
    case: 'canary-csharp',
    part: 'BlobReader, BlobReader.Read in src/BlobReader.cs',
    answer: {
      does: '`Read` returns the stream as an array, as `ToArray` would.',
      matters: 'Callers get the bytes written.',
      cited: [{ file: 'src/BlobReader.cs', side: 'base', line: 18, quote: 'return stream.GetBuffer();' }],
    },
    citesPart: false,
    namesInChange: false,
  },
  {
    case: 'criteria-python',
    part: 'load in src/tomli/_parser.py',
    answer: {
      does: '`load` now also takes a `str` or `os.PathLike` path, which it opens with `open` and parses.',
      matters: 'It is the feature itself; its test reads a path.',
      cited: [
        { file: 'src/tomli/_parser.py', side: 'head', line: 142, quote: 'if isinstance(__fp, (str, os.PathLike)):' },
        { file: 'src/tomli/_parser.py', side: 'base', line: 137, quote: 'def load(__fp: IO[bytes], *, parse_float: ParseFloat = float) -> dict[str, Any]:' },
      ],
    },
    citesPart: true,
    namesInChange: true,
  },
  {
    case: 'criteria-python',
    part: 'load in src/tomli/_parser.py',
    answer: {
      does: '`load` opens a path it is given.',
      matters: 'It is the feature itself.',
      cited: [{ file: 'src/tomli/_parser.py', side: 'head', line: 142, quote: 'if isinstance(__fp, str):' }],
    },
    citesPart: false,
    namesInChange: true,
  },
  {
    case: 'criteria-python',
    part: 'load in src/tomli/_parser.py',
    answer: {
      does: '`load` opens a path it is given.',
      matters: 'It is the feature itself.',
      cited: [
        { file: 'src/tomli/_parser.py', side: 'head', line: 143, quote: 'with open(__fp, "rb") as f:' },
        { file: 'src/tomli/_parser.py', side: 'head', line: 300, quote: 'return out.data.dict' },
      ],
    },
    citesPart: false,
    namesInChange: true,
  },
  {
    case: 'encode-httpx-3690',
    part: 'HTTPParser.wait_ready, HTTPParser in src/httpx/_parsers.py',
    answer: {
      does: '`wait_ready` returns what `self.parser.wait_ready` returns: whether data started arriving before the stream closed.',
      matters: 'The loop in `handle_requests` calls it before reading a request.',
      cited: [{ file: 'src/httpx/_parsers.py', side: 'head', line: 232, quote: 'return self.parser.wait_ready()' }],
    },
    citesPart: true,
    namesInChange: true,
  },
  {
    case: 'encode-httpx-3690',
    part: 'HTTPParser.wait_ready, HTTPParser in src/httpx/_parsers.py',
    answer: {
      does: '`wait_ready` waits on an `asyncio.Event` until data arrives.',
      matters: 'The server reads a request only once it returns.',
      cited: [{ file: 'src/httpx/_parsers.py', side: 'head', line: 227, quote: 'def wait_ready(self) -> bool:' }],
    },
    citesPart: true,
    namesInChange: false,
  },
  {
    case: 'encode-httpx-3690',
    part: 'HTTPServer.wait in src/httpx/_server.py',
    answer: {
      does: '`wait` now calls `sleep(1)` in its loop with no `KeyboardInterrupt` handler around it.',
      matters: 'An interrupt now leaves the loop by raising instead of breaking out of it.',
      cited: [
        { file: 'src/httpx/_server.py', side: 'base', line: 107, quote: 'except KeyboardInterrupt:' },
        { file: 'src/httpx/_server.py', side: 'head', line: 113, quote: 'sleep(1)' },
      ],
    },
    citesPart: true,
    namesInChange: true,
  },
  {
    case: 'encode-httpx-3690',
    part: 'HTTPServer.wait in src/httpx/_server.py',
    answer: {
      does: '`wait` loops forever, sleeping a second at a time.',
      matters: 'Stopping the server now needs `signal.SIGINT` handled elsewhere.',
      cited: [{ file: 'src/httpx/_server.py', side: 'head', line: 112, quote: 'while(True):' }],
    },
    citesPart: true,
    namesInChange: false,
  },
  {
    case: 'sindresorhus-ky-880',
    part: 'deepMergeInternal in source/utils/merge.ts',
    answer: {
      does: 'An `AbortSignal` is collected into `signals` only at the root options, where `isRootSignal` holds; a replace or `undefined` clears them first.',
      matters: 'It is how an extended instance combines its signals, which the tests exercise.',
      cited: [{ file: 'source/utils/merge.ts', side: 'head', line: 227, quote: "const isRootSignal = isRoot && key === 'signal';" }],
    },
    citesPart: true,
    namesInChange: true,
  },
  {
    case: 'sindresorhus-ky-880',
    part: 'deepMergeInternal in source/utils/merge.ts',
    answer: {
      does: 'It calls `resetSignals` when a signal is replaced.',
      matters: 'Extended instances rely on it.',
      cited: [{ file: 'source/utils/merge.ts', side: 'head', line: 400, quote: 'resetSignals(signals);' }],
    },
    citesPart: false,
    namesInChange: false,
  },
];

describe('the explain checks against hand labels', () => {
  it("agree with every hand label on the hand-written explanations of the cases' labelled parts", async () => {
    const cases = new Map((await loadCases([CASES])).map((each) => [each.id, each]));
    const disagreements: string[] = [];
    for (const labelled of LABELLED) {
      const evaluationCase = cases.get(labelled.case)!;
      expect(evaluationCase.expected.explain, labelled.case).toContain(labelled.part);
      const { parts } = await reviewChange(await caseInput(evaluationCase));
      const index = labelledPart(parts, labelled.part);
      expect(index, labelled.part).toBeGreaterThanOrEqual(0);
      const checks = explainChecks(parts[index]!, changeText(parts), labelled.answer);
      const got = { citesPart: checks.cited.length > 0 && checks.refused.length === 0, namesInChange: checks.names.outside.length === 0 };
      for (const label of ['citesPart', 'namesInChange'] as const) {
        if (got[label] !== labelled[label]) {
          disagreements.push(`${labelled.case} ${labelled.part} ${label}: labelled ${labelled[label]}, checked ${got[label]} (${[...checks.refused, ...checks.names.outside].join('; ')})`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('label every check both ways, each independently of the other, so agreement means something', () => {
    const pairs = new Set(LABELLED.map((labelled) => `${labelled.citesPart} ${labelled.namesInChange}`));
    expect(pairs).toEqual(new Set(['true true', 'true false', 'false true', 'false false']));
  });

  it("cover every part the cases explain, and only the cases tied to the explain prompt explain", async () => {
    const cases = await loadCases([CASES]);
    for (const each of cases) {
      expect(each.record.prompts.includes('explain'), each.id).toBe(each.expected.explain !== undefined);
      for (const part of each.expected.explain ?? []) {
        expect(LABELLED.some((labelled) => labelled.case === each.id && labelled.part === part), `${each.id} ${part}`).toBe(true);
      }
    }
  });
});
