import { t } from '../../shared/i18n';
/** The views of one item, such as a scenario or a test: what it does, its code, its diagram. */
export type ItemView = 'description' | 'code' | 'diagram';
export type ViewOptions = readonly (readonly [ItemView, string])[];
const itemViews: ViewOptions = [
  ['description', t('Description')],
  ['code', t('Code')],
  ['diagram', t('Diagram')],
];

/** A segmented switch between the views; the diagram is off when nothing can be drawn. */
export function ViewSwitch({
  view,
  onView,
  label,
  diagram = true,
  options = itemViews,
}: {
  view: ItemView;
  onView: (view: ItemView) => void;
  label: string;
  diagram?: boolean;
  options?: ViewOptions;
}) {
  return (
    <div className="view-switch" role="tablist" aria-label={label}>
      {options.map(([id, title]) => (
        <button
          key={id}
          role="tab"
          aria-selected={view === id}
          disabled={id === 'diagram' && !diagram}
          className={view === id ? 'active' : undefined}
          onClick={() => onView(id)}
        >
          {title}
        </button>
      ))}
    </div>
  );
}
