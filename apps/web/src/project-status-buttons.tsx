import {
  projectStatusLabels,
  projectStatusDescriptions,
  type ProjectStatus,
} from "@partner-report/contracts/project-status";
import "./project-status-buttons.css";

export function ProjectStatusButtons({
  value,
  disabled,
  onChange,
}: {
  value: ProjectStatus;
  disabled?: boolean;
  onChange: (value: ProjectStatus) => void;
}) {
  return (
    <div
      className="project-status-buttons"
      role="group"
      aria-label="选择项目状态"
    >
      {(Object.entries(projectStatusLabels) as [ProjectStatus, string][]).map(
        ([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={value === key}
            title={projectStatusDescriptions[key]}
            disabled={disabled}
            onClick={() => onChange(key)}
          >
            {value === key ? "✓ " : ""}
            {label}
          </button>
        ),
      )}
    </div>
  );
}
