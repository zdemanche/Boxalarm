import type { ReactNode } from 'react';
import * as RadixTabs from '@radix-ui/react-tabs';
import styles from './Tabs.module.css';

export interface TabItem {
  value: string;
  label: string;
  content: ReactNode;
}

interface TabsProps {
  items: TabItem[];
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  label: string;
}

export function Tabs({ items, defaultValue, value, onValueChange, label }: TabsProps) {
  return (
    <RadixTabs.Root
      defaultValue={defaultValue ?? items[0]?.value}
      value={value}
      onValueChange={onValueChange}
    >
      <RadixTabs.List className={styles.list} aria-label={label}>
        {items.map((item) => (
          <RadixTabs.Trigger key={item.value} value={item.value} className={styles.trigger}>
            {item.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {items.map((item) => (
        <RadixTabs.Content key={item.value} value={item.value} className={styles.content}>
          {item.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}
