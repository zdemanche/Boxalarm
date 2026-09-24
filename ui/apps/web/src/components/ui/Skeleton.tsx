import styles from './Skeleton.module.css';

interface SkeletonProps {
  lines?: number;
}

/** Matches the final layout shape rather than a bare spinner (Moonaan standard). Static, not
 * shimmering — an animated skeleton carries no information the reduced-motion alternative
 * would need to replace, so there is nothing to gate on prefers-reduced-motion here. */
export function Skeleton({ lines = 3 }: SkeletonProps) {
  return (
    <div aria-hidden="true" aria-busy="true">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className={styles.line} />
      ))}
    </div>
  );
}

export function SkeletonBlock({ height = 120 }: { height?: number }) {
  return <div aria-hidden="true" className={styles.block} style={{ height }} />;
}
