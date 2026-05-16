export const ANNOTATOR_ROOT_ATTR = "data-vpg-annotator-root";

export const ANNOTATOR_STYLES = `
[${ANNOTATOR_ROOT_ATTR}] {
  --vpg-annotator-accent: #4f46e5;
  --vpg-annotator-accent-strong: #4338ca;
  --vpg-annotator-bg: rgba(15, 23, 42, 0.96);
  --vpg-annotator-bg-soft: rgba(30, 41, 59, 0.96);
  --vpg-annotator-border: rgba(148, 163, 184, 0.28);
  --vpg-annotator-text: #e2e8f0;
  --vpg-annotator-text-soft: #94a3b8;
  --vpg-annotator-shadow: 0 16px 40px rgba(15, 23, 42, 0.26);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--vpg-annotator-text);
}

[${ANNOTATOR_ROOT_ATTR}] * {
  box-sizing: border-box;
}

.vpg-annotator-toolbar {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 2147483647;
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px;
  border-radius: 14px;
  background: var(--vpg-annotator-bg);
  border: 1px solid var(--vpg-annotator-border);
  box-shadow: var(--vpg-annotator-shadow);
  backdrop-filter: blur(18px);
}

.vpg-annotator-btn {
  appearance: none;
  border: 1px solid var(--vpg-annotator-border);
  background: var(--vpg-annotator-bg-soft);
  color: var(--vpg-annotator-text);
  border-radius: 10px;
  padding: 7px 10px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
}

.vpg-annotator-btn:hover {
  border-color: rgba(99, 102, 241, 0.45);
}

.vpg-annotator-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.vpg-annotator-btn--primary,
.vpg-annotator-btn[aria-pressed="true"] {
  background: var(--vpg-annotator-accent);
  border-color: var(--vpg-annotator-accent);
  color: white;
}

.vpg-annotator-panel,
.vpg-annotator-input,
.vpg-annotator-settings {
  position: fixed;
  z-index: 2147483647;
  min-width: 300px;
  max-width: min(560px, calc(100vw - 24px));
  background: var(--vpg-annotator-bg);
  border: 1px solid var(--vpg-annotator-border);
  border-radius: 14px;
  box-shadow: var(--vpg-annotator-shadow);
  backdrop-filter: blur(18px);
  overflow: hidden;
}

.vpg-annotator-settings {
  min-width: 260px;
  max-width: min(320px, calc(100vw - 24px));
}

.vpg-annotator-arrow {
  position: absolute;
  width: 12px;
  height: 12px;
  background: var(--vpg-annotator-bg);
  border: 1px solid var(--vpg-annotator-border);
  transform: rotate(45deg);
}

.vpg-annotator-panel[data-placement^="top"] .vpg-annotator-arrow,
.vpg-annotator-input[data-placement^="top"] .vpg-annotator-arrow,
.vpg-annotator-settings[data-placement^="top"] .vpg-annotator-arrow {
  border-top: none;
  border-left: none;
}

.vpg-annotator-panel[data-placement^="bottom"] .vpg-annotator-arrow,
.vpg-annotator-input[data-placement^="bottom"] .vpg-annotator-arrow,
.vpg-annotator-settings[data-placement^="bottom"] .vpg-annotator-arrow {
  border-right: none;
  border-bottom: none;
}

.vpg-annotator-panel[data-placement^="left"] .vpg-annotator-arrow,
.vpg-annotator-input[data-placement^="left"] .vpg-annotator-arrow,
.vpg-annotator-settings[data-placement^="left"] .vpg-annotator-arrow {
  border-left: none;
  border-bottom: none;
}

.vpg-annotator-panel[data-placement^="right"] .vpg-annotator-arrow,
.vpg-annotator-input[data-placement^="right"] .vpg-annotator-arrow,
.vpg-annotator-settings[data-placement^="right"] .vpg-annotator-arrow {
  border-top: none;
  border-right: none;
}

.vpg-annotator-panel-body,
.vpg-annotator-input-body,
.vpg-annotator-settings-body {
  position: relative;
  z-index: 1;
  padding: 14px;
}

.vpg-annotator-heading {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 700;
}

.vpg-annotator-subtle {
  margin: 0;
  font-size: 12px;
  color: var(--vpg-annotator-text-soft);
}

.vpg-annotator-textarea,
.vpg-annotator-comment {
  width: 100%;
  border: 1px solid var(--vpg-annotator-border);
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.72);
  color: var(--vpg-annotator-text);
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.55;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.vpg-annotator-textarea {
  min-height: 220px;
  resize: vertical;
  margin-top: 12px;
}

.vpg-annotator-comment {
  min-height: 92px;
  resize: vertical;
  font-family: inherit;
}

.vpg-annotator-input-meta {
  width: 100%;
  min-height: 160px;
  margin-bottom: 10px;
}

.vpg-annotator-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
}

.vpg-annotator-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 12px;
}

.vpg-annotator-field {
  display: grid;
  gap: 6px;
  margin-top: 12px;
}

.vpg-annotator-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--vpg-annotator-text-soft);
}

.vpg-annotator-select,
.vpg-annotator-checkbox {
  accent-color: var(--vpg-annotator-accent);
}

.vpg-annotator-select {
  width: 100%;
  border: 1px solid var(--vpg-annotator-border);
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.72);
  color: var(--vpg-annotator-text);
  padding: 8px 10px;
}

.vpg-annotator-highlight {
  position: fixed;
  z-index: 2147483646;
  pointer-events: none;
  border: 2px solid var(--vpg-annotator-accent);
  border-radius: 8px;
  background: rgba(79, 70, 229, 0.08);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08);
}

.vpg-annotator-highlight-label {
  position: absolute;
  left: 0;
  top: -30px;
  max-width: min(520px, calc(100vw - 24px));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-radius: 999px;
  background: var(--vpg-annotator-accent);
  color: white;
  padding: 5px 10px;
  font-size: 12px;
  font-weight: 700;
}

.vpg-annotator-shield {
  position: fixed;
  inset: 0;
  z-index: 2147483645;
  background: transparent;
}

.vpg-annotator-marker {
  position: absolute;
  z-index: 2147483646;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  border: none;
  background: var(--vpg-annotator-accent);
  color: white;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 8px 20px rgba(15, 23, 42, 0.28);
}

.vpg-annotator-toast {
  position: fixed;
  right: 24px;
  bottom: 86px;
  z-index: 2147483647;
  border-radius: 999px;
  background: var(--vpg-annotator-bg);
  border: 1px solid var(--vpg-annotator-border);
  color: var(--vpg-annotator-text);
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  box-shadow: var(--vpg-annotator-shadow);
}
`;
