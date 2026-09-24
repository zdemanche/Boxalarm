# Boxalarm web component library — "Command console"

Import from `../components/ui` (barrel `index.ts`). Every component consumes
`@boxalarm/design-tokens` through the CSS custom properties declared in
`src/styles/tokens.ts` (`--bx-*`) — never a hardcoded color, size, or font. Palette switches by
setting `data-palette="day"` or `data-palette="cab"` on `<html>`; unset falls back to
`prefers-color-scheme`.

Status is always colour + glyph + word — never colour alone (N7.1). `StatusChip` enforces this by
requiring `children` (the word) alongside `status`.

## Button / IconButton

```tsx
<Button variant="primary" size="md" loading={isSaving} onClick={save}>
  Save check
</Button>
<IconButton icon={Settings} label="Open settings" onClick={openSettings} />
```

Props: `variant?: 'primary' | 'secondary' | 'ghost' | 'danger'`, `size?: 'sm' | 'md' | 'lg'`,
`loading?: boolean` (Button only), plus native `<button>` attributes. `IconButton` additionally
requires `icon: LucideIcon` and `label: string` (used as the accessible name).

## Card / Stat

```tsx
<Card title="Open defects">3 apparatus have an open defect.</Card>
<Stat label="Units in service" value="4 / 5" hint="Rescue 300 OOS" alarm />
```

`Card` props: `title?: string`, `raised?: boolean`. `Stat` props: `label`, `value: ReactNode`,
`hint?: ReactNode`, `alarm?: boolean` (renders the value in the danger status colour).

## PageHeader

```tsx
<PageHeader
  title="Apparatus"
  breadcrumbs={[{ label: 'Apparatus', to: '/apparatus' }, { label: 'Engine 301' }]}
  actions={<Button>Add apparatus</Button>}
/>
```

## StatusChip / Badge

```tsx
<StatusChip status="ok">In service</StatusChip>
<StatusChip status="danger">Out of service</StatusChip>
<Badge>Probationary</Badge>
```

`StatusChip` props: `status: 'ok' | 'warning' | 'caution' | 'danger' | 'info' | 'neutral'`,
`children: ReactNode` (the word — required). `Badge` is a neutral pill for non-status labels
(role names, counts).

## DataTable

```tsx
<DataTable
  caption="Apparatus registry"
  rowKey={(unit) => unit.apparatusId}
  columns={[
    { key: 'unitId', header: 'Unit', render: (u) => u.unitId, sortValue: (u) => u.unitId },
    { key: 'status', header: 'Status', render: (u) => <StatusChip status={u.status === 'IN_SERVICE' ? 'ok' : 'danger'}>{u.status}</StatusChip> },
  ]}
  rows={units}
  density="comfortable"
  loading={query.isLoading}
  error={query.error ? 'Could not load apparatus.' : undefined}
  emptyMessage="No apparatus yet."
/>
```

`density?: 'comfortable' | 'dense'` (56px vs 44px rows — 44px is the floor, never smaller).
Sortable columns pass `sortValue`; the header becomes a button and toggles asc → desc → unsorted.

## Tabs

```tsx
<Tabs
  label="Member sections"
  items={[
    { value: 'quals', label: 'Quals', content: <QualsPanel /> },
    { value: 'certs', label: 'Certifications', content: <CertsPanel /> },
  ]}
/>
```

## Field controls — TextInput, Textarea, Select, Combobox, Checkbox, DatePicker

```tsx
<TextInput label="Unit ID" value={form.unitId} onChange={(e) => setUnitId(e.target.value)} required />
<Textarea label="Notes" optional value={notes} onChange={(e) => setNotes(e.target.value)} />
<Select label="Type" value={type} onChange={(e) => setType(e.target.value)}>
  <option value="engine">Engine</option>
</Select>
<Combobox label="Apparatus" value={apparatusId} onValueChange={setApparatusId} options={options} />
<Checkbox label="Notify training officer" checked={notify} onCheckedChange={setNotify} />
<DatePicker label="Issued" value={issued} onChange={(e) => setIssued(e.target.value)} />
```

All six share the same label/help/error wiring: a persistent visible `<label>`, `aria-describedby`
pointing at help then error text, `aria-invalid` when `error` is set, and `(optional)` appended to
the label when `optional` is true (most fields are required by convention — mark the exceptions).

## Dialog / ConfirmDialog

```tsx
<ConfirmDialog
  open={open}
  onOpenChange={setOpen}
  title="Place Engine 301 out of service?"
  consequence="It will be removed from riding assignments and the alert roster until returned to service."
  confirmLabel="Place out of service"
  onConfirm={markOos}
  danger
/>
```

Use `Dialog` directly for a non-destructive dialog with custom body content. Reversible actions
should prefer an undo affordance (a toast with an action) over a confirm dialog — see `Toast`.

## Toast

```tsx
const { showToast } = useToast(); // needs <ToastProvider> mounted once near the app root
showToast('Riding assignment saved.', 'ok');
showToast('Member removed.', 'default', { label: 'Undo', onClick: restoreMember });
```

`ToastProvider` renders its own `role="status"` live region — no separate announcement call
needed. `tone?: 'default' | 'ok' | 'danger'`, `action?: { label: string; onClick: () => void }` —
the optional single control this doc points to above for a reversible action over a
ConfirmDialog; choosing it also dismisses the toast.

## Skeleton / SkeletonBlock

```tsx
{query.isLoading ? <Skeleton lines={4} /> : <MemberList members={query.data} />}
```

Matches the shape of the content that will replace it — never a bare spinner.

## EmptyState

```tsx
<EmptyState
  icon={Truck}
  title="No apparatus yet"
  description="The department administrator adds apparatus in settings."
  action={<Button onClick={openAdd}>Add apparatus</Button>}
/>
```

## Toolbar / FilterBar

```tsx
<Toolbar>
  <FilterBar searchLabel="Search members" searchValue={q} onSearchChange={setQ}>
    <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>…</Select>
  </FilterBar>
  <ToolbarGroup>
    <Button>Add member</Button>
  </ToolbarGroup>
</Toolbar>
```

## Icons

`./icons` re-exports the `lucide-react` icons used across the app (so call sites don't add their
own `lucide-react` imports) plus `STATUS_ICON` / `STATUS_WORD`, the status-role → glyph/word maps
`StatusChip` uses internally.
