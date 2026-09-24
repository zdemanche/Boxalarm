import type { ReactNode } from 'react';
import { Search } from './icons';
import styles from './Toolbar.module.css';

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className={styles.toolbar}>{children}</div>;
}

export function ToolbarGroup({ children }: { children: ReactNode }) {
  return <div className={styles.group}>{children}</div>;
}

interface FilterBarProps {
  searchLabel: string;
  searchValue: string;
  onSearchChange: (value: string) => void;
  children?: ReactNode;
}

/** Search box + arbitrary filter controls, left-aligned in a Toolbar group. */
export function FilterBar({ searchLabel, searchValue, onSearchChange, children }: FilterBarProps) {
  return (
    <ToolbarGroup>
      <div className={styles.searchWrap}>
        <Search size={16} className={styles.searchIcon} aria-hidden="true" />
        <input
          type="search"
          aria-label={searchLabel}
          placeholder={searchLabel}
          value={searchValue}
          onChange={(e) => onSearchChange(e.target.value)}
          className={styles.searchInput}
        />
      </div>
      {children}
    </ToolbarGroup>
  );
}
