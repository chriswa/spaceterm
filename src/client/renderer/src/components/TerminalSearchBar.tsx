import { useEffect, useRef, useState, useCallback } from 'react'
import type { SearchAddon } from '@xterm/addon-search'

const DECORATIONS = {
  matchBackground: '#585b7066',
  matchBorder: '#585b7000',
  matchOverviewRuler: '#585b70',
  activeMatchBackground: '#ff8a42',
  activeMatchBorder: '#ff8a4200',
  activeMatchColorOverviewRuler: '#ff8a42',
}

interface TerminalSearchBarProps {
  searchAddon: SearchAddon
  onClose: () => void
}

export function TerminalSearchBar({ searchAddon, onClose }: TerminalSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [regex, setRegex] = useState(false)
  const [regexError, setRegexError] = useState(false)
  const [resultIndex, setResultIndex] = useState(-1)
  const [resultCount, setResultCount] = useState(0)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    const disposable = searchAddon.onDidChangeResults((e) => {
      if (e) {
        setResultIndex(e.resultIndex)
        setResultCount(e.resultCount)
      } else {
        setResultIndex(-1)
        setResultCount(0)
      }
    })
    return () => disposable.dispose()
  }, [searchAddon])

  const doSearch = useCallback((term: string, isRegex: boolean, incremental: boolean) => {
    if (!term) {
      searchAddon.clearDecorations()
      setResultIndex(-1)
      setResultCount(0)
      return
    }
    if (isRegex) {
      try {
        new RegExp(term)
        setRegexError(false)
      } catch {
        setRegexError(true)
        searchAddon.clearDecorations()
        setResultIndex(-1)
        setResultCount(0)
        return
      }
    } else {
      setRegexError(false)
    }
    searchAddon.findNext(term, { regex: isRegex, incremental, decorations: DECORATIONS })
  }, [searchAddon])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setQuery(val)
    doSearch(val, regex, true)
  }, [regex, doSearch])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) {
        searchAddon.findPrevious(query, { regex, decorations: DECORATIONS })
      } else {
        searchAddon.findNext(query, { regex, decorations: DECORATIONS })
      }
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      searchAddon.findNext(query, { regex, decorations: DECORATIONS })
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      searchAddon.findPrevious(query, { regex, decorations: DECORATIONS })
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }, [query, regex, searchAddon, onClose])

  const toggleRegex = useCallback(() => {
    const next = !regex
    setRegex(next)
    doSearch(query, next, true)
  }, [regex, query, doSearch])

  const countLabel = query
    ? resultCount > 0
      ? `${resultIndex + 1} of ${resultCount}`
      : 'No results'
    : ''

  return (
    <div className="terminal-search-bar" onMouseDown={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        className={`terminal-search-bar__input${regexError ? ' terminal-search-bar__input--error' : ''}`}
        type="text"
        value={query}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        placeholder="Search..."
        spellCheck={false}
      />
      <button
        className={`terminal-search-bar__btn terminal-search-bar__regex${regex ? ' terminal-search-bar__regex--active' : ''}`}
        onClick={toggleRegex}
        title="Toggle regex"
      >.*</button>
      <span className="terminal-search-bar__count">{countLabel}</span>
      <button className="terminal-search-bar__btn" onClick={() => searchAddon.findPrevious(query, { regex, decorations: DECORATIONS })} title="Previous (Shift+Enter)">&#x2191;</button>
      <button className="terminal-search-bar__btn" onClick={() => searchAddon.findNext(query, { regex, decorations: DECORATIONS })} title="Next (Enter)">&#x2193;</button>
      <button className="terminal-search-bar__btn terminal-search-bar__close" onClick={onClose} title="Close (Escape)">&times;</button>
    </div>
  )
}
