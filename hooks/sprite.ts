// A pixel Gengar drawn with sextants: each terminal cell holds 2×3 pixels in two
// colors, the lit ones as the glyph's color, the rest as its background.

const PALETTE: Record<string, string> = {
  L: '#a880d8', // light purple: the lit left side
  P: '#8058b0', // purple: body
  D: '#684898', // shaded purple: the right side
  V: '#503078', // dark purple: outline, ears and spikes
  R: '#e03028', // red: eyes
  W: '#ffffff', // white: the grin
  K: '#101010', // black: gaps between teeth, closed eyes
}
// What a clear pixel is weighed against when a cell must drop a color.
const BACKDROP = '#1e1e1e'

// Drawn on the cell grid: every 3 rows and 2 columns make one cell, and the eyes,
// the grin and the teeth each keep to their own band of cells: a round head over
// the eyes, the grin's corners rising beside them, a round belly on two feet.
const IDLE = [
  '.V................V.',
  '.VV....V.VV.V....VV.',
  '..VV.VVVVVVVVVV.VV..',
  '..VLPPPPPPPPPPPPDV..',
  '.VLPPPPPPPPPPPPPPDV.',
  'VLPPPPPPPPPPPPPPPPDV',
  'VLPPRRPPPPPPPPRRPPDV',
  'VLWPRRRRPPPPRRRRPWDV',
  'VLWWPPPPPPPPPPPPWWDV',
  'VLWWWKWWKWWKWWKWWWDV',
  'VLPWWKWWKWWKWWKWWPDV',
  'VLPPWKWWKWWKWWKWPPDV',
  '.VLPPPPPPPPPPPPPPDV.',
  '.VLPPPPPPPPPPPPPPDV.',
  '..VVVV........VVVV..',
]
const BLINK = IDLE.map((row, y) => (y === 6 ? 'VLPPPPPPPPPPPPPPPPDV' : y === 7 ? 'VLWPKKKKPPPPKKKKPWDV' : row))

const CELL_W = 2
const CELL_H = 3

export const SPRITE_WIDTH = IDLE[0]!.length / CELL_W

export type SpriteCell = { glyph: string; color?: string; backgroundColor?: string }

const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
const distance = (a: string, b: string) => {
  const [x, y] = [rgb(PALETTE[a] ?? BACKDROP), rgb(PALETTE[b] ?? BACKDROP)]
  return x.reduce((sum, v, i) => sum + (v - y[i]!) ** 2, 0)
}

// The sextant block whose lit pixels are `bits`, bit `row * 2 + col`: Unicode
// leaves out the four that are older blocks (empty, full, left and right half).
const sextant = (bits: number) => {
  if (bits === 0) return ' '
  if (bits === 63) return '█'
  if (bits === 21) return '▌'
  if (bits === 42) return '▐'
  return String.fromCodePoint(0x1fb00 + bits - 1 - (bits > 21 ? 1 : 0) - (bits > 42 ? 1 : 0))
}

const toCell = (pixels: string[]): SpriteCell => {
  // Two colors a cell: the two most common stay, any other takes the nearer.
  const counts = new Map<string, number>()
  for (const p of pixels) counts.set(p, (counts.get(p) ?? 0) + 1)
  const kept = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!).slice(0, 2)
  const snapped = pixels.map(p => (kept.includes(p) ? p : kept.reduce((m, k) => (distance(p, k) < distance(p, m) ? k : m))))
  // The clear one, if any, is the background the terminal shows through.
  const [on, off] = kept.includes('.') ? [kept.find(k => k !== '.'), '.'] : [kept[0], kept[1]]
  if (on === undefined) return { glyph: ' ' }
  const bits = snapped.reduce((b, p, i) => (p === on ? b | (1 << i) : b), 0)
  return { glyph: sextant(bits), color: PALETTE[on], backgroundColor: off === undefined ? undefined : PALETTE[off] }
}

const toCells = (rows: string[]): SpriteCell[][] => {
  const cells: SpriteCell[][] = []
  for (let y = 0; y < rows.length; y += CELL_H) {
    const row: SpriteCell[] = []
    for (let x = 0; x < rows[0]!.length; x += CELL_W) {
      const pixels: string[] = []
      for (let dy = 0; dy < CELL_H; dy++) for (let dx = 0; dx < CELL_W; dx++) pixels.push(rows[y + dy]?.[x + dx] ?? '.')
      row.push(toCell(pixels))
    }
    cells.push(row)
  }
  return cells
}

// A hop lifts the whole of him a cell row: a pixel would split the eyes and the
// grin across the grid. He stands on the lower rows and hops into the top one.
const GAP: SpriteCell[] = Array.from({ length: SPRITE_WIDTH }, () => ({ glyph: ' ' }))
const FRAMES = [
  [GAP, ...toCells(IDLE)],
  [...toCells(IDLE), GAP],
  [GAP, ...toCells(BLINK)],
]

/** The frame (0 standing, 1 in the air, 2 blinking) as rows of cells. */
export const spriteCells = (frame: number): SpriteCell[][] => FRAMES[frame] ?? FRAMES[0]!
