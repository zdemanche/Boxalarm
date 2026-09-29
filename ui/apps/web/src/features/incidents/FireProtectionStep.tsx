import { Button } from '../../components/ui/Button';
import { NerisModuleEditor } from './NerisModuleEditor';
import type { JsonRecord } from './nerisModuleSchema';
import type { NerisSchemaResponse } from './types';

/** The "Fire protection systems" step: one schema-driven editor per NERIS module shown. */
export function FireProtectionStep({
  modules,
  corePayload,
  schema,
  loading,
  locked,
  onRetry,
  onSave,
}: {
  modules: { module: string; required: boolean }[];
  corePayload: Readonly<Record<string, unknown>>;
  schema: NerisSchemaResponse | undefined;
  loading: boolean;
  locked: boolean;
  onRetry: () => void;
  onSave: (module: string, value: JsonRecord) => Promise<unknown>;
}) {
  if (loading) return <p aria-busy="true">Loading the NERIS module forms.</p>;
  return (
    <>
      {modules.map(({ module, required }) => {
        const sub = schema?.modules[module];
        if (!sub) {
          return (
            <div key={module} id={`module-${module}`} tabIndex={-1} role="status">
              <p>
                The NERIS form for the {module.replaceAll('_', ' ')} is not downloaded yet. The
                schema refreshes daily.
              </p>
              <Button type="button" variant="secondary" onClick={onRetry}>
                Try again
              </Button>
            </div>
          );
        }
        return (
          <NerisModuleEditor
            key={module}
            module={module}
            schema={sub}
            stored={corePayload[module]}
            required={required}
            locked={locked}
            onSave={(value) => onSave(module, value)}
          />
        );
      })}
    </>
  );
}
