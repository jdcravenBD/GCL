/* Starter boards, shown on the empty canvas.
 *
 * To fill a slot: build the board in the app, hit Export (the header one, which
 * writes .json), open that file and paste its contents as `board`. Set `name`
 * and `note` to whatever should appear on the tile. Nothing else to wire up —
 * the picker reads this list directly.
 *
 *   {
 *     id:    'strat',                      // stable, unique, lowercase
 *     name:  'Strat',                      // tile heading
 *     note:  'S-S-S, 6-screw trem',        // one short line under it
 *     board: { name, budget, blocks, links, view, seq }   // an Export file
 *   }
 *
 * Block ids are rewritten on load, so exported boards can be dropped in
 * unchanged and will never collide with what's already on the canvas.
 */

window.GCL_TEMPLATES = [
  { id: 'slot-1', name: 'Slot 1', note: 'Empty', board: null },
  { id: 'slot-2', name: 'Slot 2', note: 'Empty', board: null },
  { id: 'slot-3', name: 'Slot 3', note: 'Empty', board: null },
  { id: 'slot-4', name: 'Slot 4', note: 'Empty', board: null },
  { id: 'slot-5', name: 'Slot 5', note: 'Empty', board: null },
  { id: 'slot-6', name: 'Slot 6', note: 'Empty', board: null }
];
