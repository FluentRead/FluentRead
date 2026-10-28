import {describe, expect, it} from 'vitest';
import {normalizeOcrLines, normalizeOcrLineViews, restoreOcrLineCoordinates} from '@/src/features/image-translation/core';

const box = (x0: number, y0: number, x1: number, y1: number) => ({x0,y0,x1,y1});
const line = (text: string, bbox: ReturnType<typeof box>, confidence?: number) => ({text,bbox,words:[{text,bbox,confidence}]});
const vert = (text:string, bbox:ReturnType<typeof box>, confidence?:number) => ({...line(text,bbox,confidence), baseline:box(bbox.x0+1,bbox.y0,bbox.x0+2,bbox.y1)});
const blocks = (lines:any[]) => [{paragraphs:[{lines}]}];
const fixtures = {
  vertical_numeric: blocks([vert('12:34',box(60,10,80,70),96),vert('こんにちは',box(35,10,55,70),97),vert('!',box(10,10,30,70),88)]),
  overlap_and_scores: blocks([line('12:34',box(10,10,110,40),95),line('12:34',box(9,10,110,40),93),line('12:34',box(10,10,110,40),undefined),line('7:23',box(120,10,160,40),101)]),
  horizontal_mixed: blocks([{text:'Hello 世界!',bbox:box(0,0,150,30),words:[{text:'!',bbox:box(110,0,120,20),confidence:98},{text:'世界',bbox:box(60,0,100,20),confidence:96},{text:'Hello',bbox:box(0,0,40,20),confidence:95}]}]),
  filter_and_split: blocks([{text:'noise',bbox:box(0,0,20,20),words:[{text:'noise',bbox:box(0,0,20,20),confidence:10}]},{text:'FIRST SECOND',bbox:box(0,30,300,50),words:[{text:'SECOND',bbox:box(250,30,300,50),confidence:97},{text:'FIRST',bbox:box(0,30,50,50),confidence:97}]},{text:'99',bbox:box(0,60,20,80),confidence:NaN},{text:'lost',bbox:box(2,2,2,3),confidence:99},{text:'72',bbox:box(50,60,70,80),confidence:95}]),
};
// Outputs were frozen from commit 849f6be0a before the single-pass change.
const expected = {
  "vertical_numeric": {
    "ordinary": [
      {
        "text": "12:34こんにちは!",
        "bbox": {
          "x0": 10,
          "y0": 10,
          "x1": 80,
          "y1": 70
        },
        "vertical": true
      }
    ],
    "manga": [
      {
        "text": "12:34",
        "bbox": {
          "x0": 60,
          "y0": 10,
          "x1": 80,
          "y1": 70
        },
        "vertical": true,
        "numericConfidence": 96
      },
      {
        "text": "こんにちは!",
        "bbox": {
          "x0": 10,
          "y0": 10,
          "x1": 55,
          "y1": 70
        },
        "vertical": true
      }
    ],
    "scaled": [
      {
        "text": "12:34",
        "bbox": {
          "x0": 114,
          "y0": 14,
          "x1": 154,
          "y1": 134
        },
        "vertical": true,
        "numericConfidence": 96
      },
      {
        "text": "こんにちは!",
        "bbox": {
          "x0": 14,
          "y0": 14,
          "x1": 104,
          "y1": 134
        },
        "vertical": true
      }
    ]
  },
  "overlap_and_scores": {
    "ordinary": [
      {
        "text": "12:34",
        "bbox": {
          "x0": 10,
          "y0": 10,
          "x1": 110,
          "y1": 40
        }
      },
      {
        "text": "7:23",
        "bbox": {
          "x0": 120,
          "y0": 10,
          "x1": 160,
          "y1": 40
        }
      }
    ],
    "manga": [
      {
        "text": "12:34",
        "bbox": {
          "x0": 9,
          "y0": 10,
          "x1": 110,
          "y1": 40
        }
      },
      {
        "text": "7:23",
        "bbox": {
          "x0": 120,
          "y0": 10,
          "x1": 160,
          "y1": 40
        }
      }
    ],
    "scaled": [
      {
        "text": "12:34",
        "bbox": {
          "x0": 12,
          "y0": 14,
          "x1": 214,
          "y1": 74
        }
      },
      {
        "text": "7:23",
        "bbox": {
          "x0": 234,
          "y0": 14,
          "x1": 300,
          "y1": 74
        }
      }
    ]
  },
  "horizontal_mixed": {
    "ordinary": [
      {
        "text": "Hello世界!",
        "bbox": {
          "x0": 0,
          "y0": 0,
          "x1": 120,
          "y1": 20
        }
      }
    ],
    "manga": [
      {
        "text": "Hello世界!",
        "bbox": {
          "x0": 0,
          "y0": 0,
          "x1": 120,
          "y1": 20
        },
        "numericConfidence": 95
      }
    ],
    "scaled": [
      {
        "text": "Hello世界!",
        "bbox": {
          "x0": 0,
          "y0": 0,
          "x1": 234,
          "y1": 34
        },
        "numericConfidence": 95
      }
    ]
  },
  "filter_and_split": {
    "ordinary": [
      {
        "text": "FIRST",
        "bbox": {
          "x0": 0,
          "y0": 30,
          "x1": 50,
          "y1": 50
        }
      },
      {
        "text": "SECOND",
        "bbox": {
          "x0": 250,
          "y0": 30,
          "x1": 300,
          "y1": 50
        }
      },
      {
        "text": "72",
        "bbox": {
          "x0": 50,
          "y0": 60,
          "x1": 70,
          "y1": 80
        }
      }
    ],
    "manga": [
      {
        "text": "FIRST",
        "bbox": {
          "x0": 0,
          "y0": 30,
          "x1": 50,
          "y1": 50
        }
      },
      {
        "text": "SECOND",
        "bbox": {
          "x0": 250,
          "y0": 30,
          "x1": 300,
          "y1": 50
        }
      },
      {
        "text": "72",
        "bbox": {
          "x0": 50,
          "y0": 60,
          "x1": 70,
          "y1": 80
        },
        "numericConfidence": 95
      }
    ],
    "scaled": [
      {
        "text": "FIRST",
        "bbox": {
          "x0": 0,
          "y0": 54,
          "x1": 94,
          "y1": 94
        }
      },
      {
        "text": "72",
        "bbox": {
          "x0": 94,
          "y0": 114,
          "x1": 134,
          "y1": 154
        },
        "numericConfidence": 95
      }
    ]
  }
} as const;

describe('OCR dual views preserve the pre-optimization output', () => {
  it.each(Object.entries(fixtures))('%s retains both views, ordering and scaled boxes', (name, input) => {
    const expectedViews = expected[name as keyof typeof expected];
    const result = normalizeOcrLineViews(input);
    expect(result.ordinary).toEqual(expectedViews.ordinary);
    expect(result.manga).toEqual(expectedViews.manga);
    expect(normalizeOcrLines(input)).toEqual(expectedViews.ordinary);
    expect(normalizeOcrLines(input,true)).toEqual(expectedViews.manga);
    expect(restoreOcrLineCoordinates(result.manga,300,300,150,150,3)).toEqual(expectedViews.scaled);
  });
  it('keeps ordinary and manga bounding boxes independent in both directions', () => {
    const first = normalizeOcrLineViews(fixtures.horizontal_mixed);
    const initialManga = first.manga[0].bbox.x0;
    first.ordinary[0].bbox.x0 += 123;
    expect(first.manga[0].bbox.x0).toBe(initialManga);
    const second = normalizeOcrLineViews(fixtures.horizontal_mixed);
    const initialOrdinary = second.ordinary[0].bbox.y0;
    second.manga[0].bbox.y0 += 123;
    expect(second.ordinary[0].bbox.y0).toBe(initialOrdinary);
  });
});
