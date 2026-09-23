import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import * as RadixCheckbox from '@radix-ui/react-checkbox';
import * as RadixSelect from '@radix-ui/react-select';
import { Check, ChevronDown } from './icons';
import styles from './Field.module.css';

interface FieldChromeProps {
  fieldId: string;
  label: string;
  optional?: boolean;
  help?: string;
  error?: string;
  children: ReactNode;
}

function FieldChrome({ fieldId, label, optional, help, error, children }: FieldChromeProps) {
  const helpId = help ? `${fieldId}-help` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  return (
    <div className={styles.field}>
      <label htmlFor={fieldId} className={styles.label}>
        {label}
        {optional ? <span className={styles.optional}> (optional)</span> : null}
      </label>
      {children}
      {help ? (
        <span id={helpId} className={styles.help}>
          {help}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} role="alert" className={styles.error}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

function describedBy(fieldId: string, help?: string, error?: string): string | undefined {
  const ids = [help ? `${fieldId}-help` : null, error ? `${fieldId}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

interface BaseFieldProps {
  label: string;
  optional?: boolean;
  help?: string;
  error?: string;
}

type TextInputProps = BaseFieldProps &
  Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & { id?: string };

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { label, optional, help, error, required, id, className, ...rest },
  ref,
) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldChrome fieldId={fieldId} label={label} optional={optional} help={help} error={error}>
      <input
        ref={ref}
        id={fieldId}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fieldId, help, error)}
        className={[styles.control, className].filter(Boolean).join(' ')}
        {...rest}
      />
    </FieldChrome>
  );
});

export const DatePicker = forwardRef<HTMLInputElement, TextInputProps>(
  function DatePicker(props, ref) {
    return <TextInput ref={ref} type="date" {...props} />;
  },
);

type TextareaProps = BaseFieldProps &
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> & { id?: string };

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, optional, help, error, id, className, ...rest },
  ref,
) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldChrome fieldId={fieldId} label={label} optional={optional} help={help} error={error}>
      <textarea
        ref={ref}
        id={fieldId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fieldId, help, error)}
        className={[styles.control, className].filter(Boolean).join(' ')}
        {...rest}
      />
    </FieldChrome>
  );
});

type NativeSelectProps = BaseFieldProps &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> & { id?: string };

/** Native <select> — Field-wired the same way as TextInput. For the styled-listbox variant
 * (searchable, custom item rendering) use `Combobox` below. */
export const Select = forwardRef<HTMLSelectElement, NativeSelectProps>(function Select(
  { label, optional, help, error, id, className, children, ...rest },
  ref,
) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldChrome fieldId={fieldId} label={label} optional={optional} help={help} error={error}>
      <select
        ref={ref}
        id={fieldId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fieldId, help, error)}
        className={[styles.control, className].filter(Boolean).join(' ')}
        {...rest}
      >
        {children}
      </select>
    </FieldChrome>
  );
});

interface ComboboxOption {
  value: string;
  label: string;
}

interface ComboboxProps extends BaseFieldProps {
  value: string;
  onValueChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
}

/** Radix-driven styled listbox for cases the native <select> can't cover well (long option
 * labels needing custom rendering). Prefer `Select` for a plain enumerated list. */
export function Combobox({
  label,
  help,
  error,
  value,
  onValueChange,
  options,
  placeholder,
}: ComboboxProps) {
  const fieldId = useId();
  return (
    <FieldChrome fieldId={fieldId} label={label} help={help} error={error}>
      <RadixSelect.Root value={value} onValueChange={onValueChange}>
        <RadixSelect.Trigger
          id={fieldId}
          className={styles.control}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
          aria-describedby={describedBy(fieldId, help, error)}
        >
          <RadixSelect.Value placeholder={placeholder} />
          <RadixSelect.Icon>
            <ChevronDown size={16} aria-hidden="true" />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>
        <RadixSelect.Portal>
          <RadixSelect.Content
            className={styles.control}
            style={{ height: 'auto', padding: 4, background: 'var(--bx-surface-raised)' }}
            position="popper"
          >
            <RadixSelect.Viewport>
              {options.map((opt) => (
                <RadixSelect.Item
                  key={opt.value}
                  value={opt.value}
                  style={{
                    padding: '8px 10px',
                    cursor: 'pointer',
                    borderRadius: 'var(--bx-radius-sm)',
                    display: 'flex',
                    justifyContent: 'space-between',
                  }}
                >
                  <RadixSelect.ItemText>{opt.label}</RadixSelect.ItemText>
                  <RadixSelect.ItemIndicator>
                    <Check size={14} aria-hidden="true" />
                  </RadixSelect.ItemIndicator>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
    </FieldChrome>
  );
}

interface CheckboxProps {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  id?: string;
}

export function Checkbox({ label, checked, onCheckedChange, id }: CheckboxProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <div className={styles.checkboxRow}>
      <RadixCheckbox.Root
        id={fieldId}
        className={styles.checkboxRoot}
        checked={checked}
        onCheckedChange={(state) => onCheckedChange(state === true)}
      >
        <RadixCheckbox.Indicator>
          <Check size={14} aria-hidden="true" />
        </RadixCheckbox.Indicator>
      </RadixCheckbox.Root>
      <label htmlFor={fieldId} className={styles.label} style={{ fontWeight: 400 }}>
        {label}
      </label>
    </div>
  );
}
