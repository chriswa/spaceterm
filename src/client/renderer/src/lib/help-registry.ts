/**
 * Central registry of all keyboard shortcuts, mouse interactions, and hidden
 * features. Drives the HelpModal (Cmd+?) so that every discoverable
 * interaction is documented in one place.
 *
 * Groups are rendered in array order — put the most essential stuff first so
 * new users see it without scrolling.
 */

export interface HelpEntry {
  /** Human-readable key combo, e.g. "Cmd + S" or "Click" */
  keys: string
  /** One-line description of what this does */
  description: string
}

export interface HelpGroup {
  title: string
  /** Optional description rendered below the group title */
  description?: string
  entries: HelpEntry[]
}

const MAC_CMD = '\u2318'   // ⌘
const SHIFT   = '\u21E7'   // ⇧
const ENTER   = '\u23CE'   // ⏎
const UP      = '\u2191'   // ↑
const DOWN    = '\u2193'   // ↓
const LEFT    = '\u2190'   // ←
const RIGHT   = '\u2192'   // →

export const helpGroups: HelpGroup[] = [
  // ── Help ────────────────────────────────────────────────────────────
  {
    title: 'Help',
    entries: [
      { keys: `${MAC_CMD} ?`,            description: 'Show this help screen' },
    ],
  },

  // ── Getting Around ──────────────────────────────────────────────────
  {
    title: 'Getting Around',
    entries: [
      { keys: 'Drag canvas',             description: 'Pan the canvas' },
      { keys: 'Pinch / Scroll',          description: 'Zoom in and out' },
      { keys: 'Middle-mouse drag',       description: 'Pan from anywhere, even over nodes' },
      { keys: 'Double-click canvas',     description: 'Fit all nodes in view' },
      { keys: 'Click a node',            description: 'Focus the node' },
      { keys: `${MAC_CMD} ${UP}`,        description: 'Select parent node; from root, fit all' },
      { keys: `${MAC_CMD} ${DOWN}`,      description: 'Jump to highest-priority unattended Claude surface' },
      { keys: `${MAC_CMD} ${LEFT} / ${RIGHT}`, description: 'Cycle through Claude surfaces in toolbar order' },
      { keys: `${MAC_CMD} [  /  ]`,      description: 'Camera history back / forward' },
      { keys: 'Escape',                   description: 'Close modals, cancel reparent, or stop TTS' },
    ],
  },

  // ── Creating Nodes ──────────────────────────────────────────────────
  {
    title: 'Creating Nodes',
    description: 'You can also use the + button in any node\u2019s title bar to create a child node.',
    entries: [
      { keys: `${MAC_CMD} T`,            description: 'New terminal (from markdown parent, sends its content as input)' },
      { keys: `${MAC_CMD} E`,            description: 'New Claude surface' },
      { keys: `${MAC_CMD} M`,            description: 'New markdown note' },
      { keys: `${MAC_CMD} Click edge`,   description: 'Split an edge \u2014 insert a new node between parent and child' },
    ],
  },

  // ── Managing Nodes ──────────────────────────────────────────────────
  {
    title: 'Managing Nodes',
    entries: [
      { keys: `${MAC_CMD} W`,            description: 'Archive (close) the focused node' },
      { keys: `${MAC_CMD} Z`,            description: 'Undo last archive (buggy!)' },
      { keys: `${MAC_CMD} D`,            description: 'Fork the focused Claude surface' },
      { keys: 'Drag a node',             description: 'Move the node and all its children' },
      { keys: `${MAC_CMD} Drag`,         description: 'Move only the dragged node (children stay put)' },
    ],
  },

  // ── Search & Find ───────────────────────────────────────────────────
  {
    title: 'Search & Find',
    entries: [
      { keys: `${MAC_CMD} S  /  ${MAC_CMD} K`, description: 'Open node search (WIP)' },
      { keys: `${MAC_CMD} F`,            description: 'Find text in the focused terminal' },
      { keys: `${MAC_CMD} P`,            description: "Jump to Claude's plan in the focused terminal (also happens automatically on focus)" },
    ],
  },

  // ── Click & Interact ───────────────────────────────────────────────
  {
    title: 'Click & Interact',
    entries: [
      { keys: `${MAC_CMD} Click node`,   description: 'Open quick-actions toolbar (color, fork, archive, add child, etc.)' },
      { keys: 'Click terminal title',    description: 'Rename the terminal (when focused)' },
      { keys: `${MAC_CMD} Click edge`,   description: 'Insert a new node between two connected nodes' },
      { keys: 'Click without Cmd on edge', description: 'Shows a hint to hold Cmd' },
      { keys: `${MAC_CMD} Click link`,   description: 'Open a URL from a terminal in the browser' },
    ],
  },

  // ── Node Relationships & Inheritance ────────────────────────────────
  {
    title: 'Node Relationships',
    description: 'Special things happen depending on the structure of your tree.',
    entries: [
      { keys: 'Terminal from Markdown',   description: 'Heading becomes terminal name; body becomes initial command input' },
      { keys: 'Claude from Markdown',     description: 'All ancestor markdown & file paths are gathered as context for the system prompt' },
      { keys: 'Claude from any ancestor', description: 'Walks the full ancestor chain \u2014 every non-file-backed markdown and every file path is included' },
      { keys: 'Markdown under File',      description: 'Markdown becomes file-backed: content is read from disk and live-watched for changes' },
      { keys: 'File path change',         description: 'All file-backed markdown children automatically re-watch the new file' },
      { keys: 'CWD inheritance',          description: 'New terminals inherit working directory from the nearest ancestor terminal or directory' },
      { keys: 'Color inheritance',        description: 'Nodes inherit their color from the nearest ancestor with a color set' },
      { keys: 'Archive a node',           description: 'Children are reparented to the archived node\u2019s parent (grandparent)' },
      { keys: 'Unarchive Claude surface', description: 'Automatically resumes the most recent session in that surface' },
    ],
  },

  // ── Markdown Notes ──────────────────────────────────────────────────
  {
    title: 'Markdown Notes',
    entries: [
      { keys: 'Click when focused',      description: 'Enter edit mode' },
      { keys: 'Drag bottom-right corner', description: 'Resize / set max width' },
      { keys: 'Escape',                   description: 'Exit edit mode' },
      { keys: '"Ship It" button',         description: 'Paste markdown content into parent terminal' },
    ],
  },

  // ── Directory & File Cards ─────────────────────────────────────────
  {
    title: 'Directory & File Cards',
    entries: [
      { keys: 'Click path when focused',  description: 'Edit the directory or file path' },
      { keys: 'Git status bar',           description: 'Shows branch, ahead/behind, staged/unstaged counts' },
      { keys: 'Click fetch age',          description: 'Trigger a git fetch' },
    ],
  },

  // ── Audio & Speech ──────────────────────────────────────────────────
  {
    title: 'Audio & Speech',
    entries: [
      { keys: `${MAC_CMD} ${SHIFT} S`,   description: 'Read selected terminal text aloud (or stop)' },
    ],
  },

  // ── Toolbar (bottom bar) ───────────────────────────────────────────
  {
    title: 'Toolbar',
    entries: [
      { keys: 'Click a crab icon',        description: 'Jump to that Claude surface' },
      { keys: 'Drag crab icons',          description: 'Reorder Claude surfaces in the toolbar' },
    ],
  },
]
