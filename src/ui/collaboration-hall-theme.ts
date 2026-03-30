export function renderCollaborationHallTheme(): string {
  return `
    .collaboration-hall-card {
      overflow: hidden;
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
      height: 100%;
      max-height: 100%;
      border: 1px solid rgba(18, 44, 64, 0.08);
      background: #f8fbff;
      box-shadow: 0 14px 36px rgba(17, 43, 68, 0.08);
    }
    .hall-shell {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: 8px;
      margin-top: 4px;
      flex: 1 1 auto;
      height: 100%;
      min-height: 0;
    }
    .hall-toolbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
    }
    .hall-room-head {
      display: inline-grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 10px;
      align-items: center;
      min-width: 0;
    }
    .hall-room-avatar {
      width: 42px;
      height: 42px;
      box-shadow: inset 0 0 0 1px rgba(15, 95, 150, 0.08);
    }
    .hall-toolbar-copy {
      display: grid;
      gap: 2px;
    }
    .hall-room-label {
      font-size: 10px;
      line-height: 1.2;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #71879a;
    }
    .hall-toolbar-copy h2 {
      margin: 0;
      font-size: 20px;
      line-height: 1.04;
      letter-spacing: -0.05em;
      color: #10293a;
    }
    .hall-toolbar-copy p {
      margin: 0;
      max-width: 520px;
      font-size: 11px;
      line-height: 1.4;
      color: #556b7c;
    }
    .hall-toolbar-meta {
      display: grid;
      gap: 4px;
      justify-items: end;
      align-content: center;
      min-width: 0;
    }
    .hall-stage-pill,
    .hall-kind-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      padding: 5px 11px;
      border: 1px solid rgba(18, 44, 64, 0.10);
      background: rgba(255,255,255,0.88);
      color: #2d5067;
      font-size: 11px;
      line-height: 1;
      white-space: nowrap;
    }
    .hall-toolbar-headline {
      font-size: 13px;
      line-height: 1.55;
      color: #18374b;
      font-weight: 600;
    }
    .hall-toolbar-meta-note {
      font-size: 11px;
      line-height: 1.35;
      color: #6f8393;
      text-align: right;
    }
    .hall-member-strip {
      display: flex;
      flex-wrap: nowrap;
      gap: 6px;
      justify-content: flex-end;
      max-width: min(520px, 100%);
      overflow: auto;
      padding-bottom: 2px;
    }
    .hall-member-pill {
      appearance: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      position: relative;
      min-width: 0;
      width: 34px;
      height: 34px;
      padding: 0;
      border-radius: 999px;
      border: 1px solid rgba(18, 44, 64, 0.10);
      background: rgba(255,255,255,0.92);
      color: #1f4158;
      cursor: pointer;
      font: inherit;
      white-space: nowrap;
      transition: transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease, background 140ms ease;
    }
    .hall-member-pill:hover {
      transform: translateY(-1px);
      box-shadow: 0 10px 20px rgba(17, 43, 68, 0.10);
    }
    .hall-member-pill--typing {
      border-color: rgba(16, 121, 192, 0.28);
      box-shadow: 0 0 0 4px rgba(16, 121, 192, 0.10);
    }
    .hall-member-pill--executing,
    .hall-member-pill--reviewing {
      border-color: rgba(24, 75, 103, 0.20);
      background: rgba(244, 248, 252, 0.96);
    }
    .hall-member-pill--queued {
      border-color: rgba(176, 118, 22, 0.16);
      background: rgba(255, 251, 245, 0.96);
    }
    .hall-member-status-dot {
      position: absolute;
      right: 1px;
      bottom: 1px;
      width: 9px;
      height: 9px;
      border-radius: 999px;
      border: 2px solid rgba(255,255,255,0.96);
      background: rgba(180, 193, 205, 0.96);
      box-shadow: 0 0 0 1px rgba(18, 44, 64, 0.06);
    }
    .hall-member-pill--typing .hall-member-status-dot {
      background: #1591e6;
      box-shadow: 0 0 0 4px rgba(21, 145, 230, 0.10);
    }
    .hall-member-pill--executing .hall-member-status-dot {
      background: #1f8f5a;
    }
    .hall-member-pill--reviewing .hall-member-status-dot {
      background: #a55ae1;
    }
    .hall-member-pill--queued .hall-member-status-dot {
      background: #f0a02d;
    }
    .hall-room-avatar,
    .hall-thread-avatar,
    .hall-member-avatar,
    .hall-task-card-avatar,
    .hall-message-avatar,
    .hall-mention-avatar,
    .hall-roster-avatar,
    .hall-empty-avatar {
      --hall-avatar-size: 34px;
    }
    .hall-room-avatar {
      --hall-avatar-size: 42px;
    }
    .hall-thread-avatar {
      --hall-avatar-size: 38px;
    }
    .hall-member-avatar,
    .hall-mention-avatar {
      --hall-avatar-size: 24px;
    }
    .hall-roster-avatar {
      --hall-avatar-size: 28px;
    }
    .hall-empty-avatar {
      --hall-avatar-size: 56px;
    }
    .hall-agent-avatar,
    .hall-pixel-avatar {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: none;
      width: var(--hall-avatar-size);
      height: var(--hall-avatar-size);
      min-width: var(--hall-avatar-size);
      max-width: none;
      padding: 0;
      border-radius: 999px;
      border: 1px solid rgba(18, 44, 64, 0.08);
      border-top-width: 1px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(242, 247, 253, 0.96));
      overflow: hidden;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.75);
      text-align: initial;
      position: relative;
    }
    .hall-agent-avatar .agent-stage {
      position: relative;
      width: 100%;
      height: 100%;
      aspect-ratio: 1 / 1;
      border: 0;
      border-radius: inherit;
      background: transparent;
      overflow: hidden;
      display: grid;
      place-items: center;
    }
    .hall-agent-avatar .agent-pixel-canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }
    .hall-member-avatar,
    .hall-task-card-avatar,
    .hall-message-avatar,
    .hall-mention-avatar {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: none;
      border-radius: 999px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(242, 247, 253, 0.96));
      border: 1px solid rgba(18, 44, 64, 0.08);
      overflow: hidden;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.75);
    }
    .hall-member-avatar {
      width: 24px;
      height: 24px;
    }
    .hall-layout {
      display: grid;
      position: relative;
      grid-template-columns: clamp(236px, 23vw, 292px) minmax(0, 1fr);
      gap: 16px;
      align-items: stretch;
      flex: 1 1 auto;
      min-height: 0;
      height: 100%;
      overflow: hidden;
    }
    .hall-pane {
      border-radius: 22px;
      border: 1px solid rgba(18, 44, 64, 0.08);
      background:
        linear-gradient(180deg, rgba(255,255,255,0.97), rgba(248,250,253,0.95));
      box-shadow: 0 10px 28px rgba(17, 43, 68, 0.05);
      padding: 16px;
    }
    .hall-pane--sidebar,
    .hall-pane--context {
      display: grid;
      gap: 12px;
      min-height: 0;
    }
    .hall-pane--sidebar {
      position: relative;
      z-index: 4;
      min-width: 0;
      border: 0;
      background: transparent;
      box-shadow: none;
      padding: 4px 0 4px 2px;
      grid-template-rows: auto minmax(0, 1fr);
      overflow: hidden;
    }
    .hall-pane--thread {
      position: relative;
      z-index: 1;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto auto auto;
      gap: 12px;
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
      height: 100%;
      overflow: hidden;
      padding: 14px 18px 10px;
      background: rgba(255,255,255,0.96);
    }
    .collaboration-hall-card.is-planning-order .hall-pane--thread {
      grid-template-rows: auto minmax(0, 1fr);
      overflow: hidden;
    }
    .collaboration-hall-card.is-planning-order .hall-thread,
    .collaboration-hall-card.is-planning-order .hall-typing-strip,
    .collaboration-hall-card.is-planning-order .hall-composer-shell {
      display: none;
    }
    .collaboration-hall-card.is-planning-order .hall-decision-panel {
      display: flex;
      min-height: 0;
      overflow: hidden;
      padding-top: 0;
      padding-right: 0;
    }
    .hall-pane--context {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: min(340px, calc(100vw - 80px));
      border-radius: 24px;
      background: rgba(255,255,255,0.98);
      box-shadow: 0 18px 44px rgba(17, 43, 68, 0.12);
      z-index: 6;
      transition: transform 180ms ease, opacity 160ms ease, box-shadow 180ms ease;
      overflow: auto;
    }
    .collaboration-hall-card.is-context-collapsed .hall-pane--context {
      opacity: 0;
      pointer-events: none;
      transform: translateX(calc(100% + 18px));
      box-shadow: none;
    }
    .collaboration-hall-card.is-context-open .hall-pane--context {
      opacity: 1;
      transform: translateX(0);
    }
    .hall-pane-head,
    .hall-thread-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
    }
    .hall-pane-head-copy {
      min-width: 120px;
      flex: 1 1 auto;
    }
    .hall-thread-identity {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 12px;
      align-items: center;
      min-width: 0;
    }
    .hall-thread-avatar {
      width: 38px;
      height: 38px;
      box-shadow: inset 0 0 0 1px rgba(15, 95, 150, 0.08);
    }
    .hall-thread-head-actions {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      justify-content: flex-end;
    }
    .hall-pane-head h3,
    .hall-thread-head h3 {
      margin: 0;
      font-size: 15px;
      letter-spacing: -0.02em;
      color: #142f42;
      white-space: nowrap;
    }
    .hall-thread-label {
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #6b8294;
      margin-bottom: 3px;
    }
    .hall-thread-subtitle {
      font-size: 12px;
      line-height: 1.4;
      color: #647a8c;
      margin-top: 2px;
    }
    .hall-pane-head .meta,
    .hall-thread-head .meta {
      font-size: 12px;
      line-height: 1.5;
      color: #738796;
      max-width: 340px;
      text-align: right;
    }
    .hall-task-list,
    .hall-detail-list {
      display: grid;
      gap: 10px;
    }
    .hall-task-list {
      min-height: 0;
      height: 100%;
      max-height: none;
      overflow: auto;
      padding-right: 2px;
      gap: 4px;
      align-content: start;
      grid-auto-rows: max-content;
      grid-auto-flow: row;
    }
    .hall-task-card {
      width: 100%;
      position: relative;
      border: 1px solid transparent;
      border-radius: 18px;
      padding: 10px 12px;
      background: rgba(255,255,255,0.68);
      text-align: left;
      cursor: pointer;
      color: #153246;
      align-self: start;
      display: block;
      min-height: 0;
      transition: transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease, background 140ms ease;
    }
    .hall-task-card:hover {
      background: rgba(248, 251, 255, 0.95);
      border-color: rgba(18, 44, 64, 0.08);
    }
    .hall-task-card.is-selected {
      border-color: rgba(13, 107, 170, 0.28);
      background: rgba(238, 247, 255, 0.98);
      box-shadow: 0 8px 18px rgba(13, 107, 170, 0.08);
    }
    .hall-task-card.is-selected::before {
      content: "";
      position: absolute;
      left: 0;
      top: 10px;
      bottom: 10px;
      width: 3px;
      border-radius: 999px;
      background: linear-gradient(180deg, rgba(16, 121, 192, 0.94), rgba(11, 98, 155, 0.92));
    }
    .hall-task-title {
      display: block;
      font-size: 13px;
      line-height: 1.32;
      font-weight: 650;
      letter-spacing: -0.015em;
      overflow: visible;
      white-space: normal;
      word-break: break-word;
    }
    .hall-task-card-row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 10px;
      align-items: center;
    }
    .hall-task-card-avatar {
      width: 34px;
      height: 34px;
    }
    .hall-task-card-copy {
      min-width: 0;
      display: grid;
      gap: 4px;
      align-content: start;
    }
    .hall-task-title-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }
    .hall-task-timestamp {
      flex: none;
      font-size: 10px;
      line-height: 1.2;
      color: #7b8d9b;
      white-space: nowrap;
    }
    .hall-task-preview {
      font-size: 11px;
      line-height: 1.42;
      color: #617687;
      overflow: visible;
      text-overflow: clip;
      display: block;
      white-space: normal;
      word-break: break-word;
    }
    .hall-task-preview.is-empty {
      display: none;
    }
    .hall-task-meta,
    .hall-message-meta,
    .hall-detail-meta {
      font-size: 11px;
      line-height: 1.5;
      color: #5f7484;
    }
    .hall-detail-actions {
      margin-top: 10px;
    }
    .hall-thread {
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 0;
      height: 100%;
      max-height: 100%;
      overflow: auto;
      padding-right: 4px;
      padding-bottom: 4px;
    }
    .hall-decision-panel {
      flex: 0 0 auto;
      margin-top: 0;
      padding-top: 6px;
      padding-right: 2px;
      overflow: visible;
    }
    .hall-decision-panel[hidden] {
      display: none;
    }
    .hall-decision-card {
      display: grid;
      gap: 8px;
      border-radius: 18px;
      border: 1px solid rgba(18, 44, 64, 0.10);
      background: #ffffff;
      padding: 12px 14px;
      box-shadow: none;
      overflow: hidden;
    }
    .hall-decision-card--planner {
      max-height: min(720px, calc(100vh - 220px));
      overflow: auto;
      overscroll-behavior: contain;
      scrollbar-gutter: stable;
    }
    .collaboration-hall-card.is-planning-order .hall-decision-card--planner {
      flex: 1 1 auto;
      min-height: 0;
      max-height: none;
      height: 100%;
    }
    .collaboration-hall-card.is-planning-order .hall-decision-card--planner.is-empty {
      flex: 0 0 auto;
      align-self: start;
      height: auto;
      max-height: none;
    }
    .hall-decision-panel .hall-decision-card {
      margin: 0;
    }
    .hall-decision-top {
      display: grid;
      gap: 8px;
      min-width: 0;
    }
    .hall-decision-copy {
      display: grid;
      gap: 6px;
      min-width: 0;
    }
    .hall-decision-title-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 10px;
      min-width: 0;
    }
    .hall-decision-label {
      font-size: 10px;
      font-weight: 700;
      text-transform: none;
      letter-spacing: 0.01em;
      color: #5f7484;
    }
    .hall-decision-inline-summary {
      min-width: 0;
      font-size: 11px;
      line-height: 1.4;
      font-weight: 600;
      color: #12344a;
      word-break: break-word;
      white-space: normal;
    }
    .hall-decision-toggle {
      flex: none;
    }
    .hall-decision-summary {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }
    .hall-decision-summary--compact {
      gap: 6px;
      color: #5f7484;
      font-size: 11px;
      line-height: 1.35;
      flex-wrap: wrap;
      min-width: 0;
      overflow: visible;
    }
    .hall-decision-meta-line-item {
      flex: 0 1 auto;
      min-width: 0;
      color: #5f7484;
      overflow: visible;
      text-overflow: clip;
      white-space: normal;
      word-break: break-word;
      max-width: 100%;
    }
    .hall-decision-meta-sep {
      color: rgba(95, 116, 132, 0.58);
    }
    .hall-decision-body {
      display: grid;
      gap: 10px;
      padding-top: 4px;
      border-top: 1px solid rgba(18, 44, 64, 0.08);
    }
    .hall-decision-card.is-collapsed .hall-decision-body {
      display: none;
    }
    .hall-decision-card.is-collapsed .hall-decision-helper {
      display: none;
    }
    .hall-decision-row {
      display: grid;
      gap: 3px;
    }
    .hall-decision-row strong {
      font-size: 10px;
      color: #5f7484;
      text-transform: none;
      letter-spacing: 0.01em;
    }
    .hall-decision-row span {
      font-size: 12px;
      line-height: 1.45;
      color: #173346;
      word-break: break-word;
      white-space: normal;
    }
    .hall-decision-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .hall-decision-actions--planner-empty {
      align-items: flex-start;
      justify-content: flex-start;
    }
    .hall-decision-helper {
      font-size: 11px;
      line-height: 1.35;
      color: #6a8192;
    }
    .hall-decision-queue {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .hall-decision-queue-item {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border-radius: 999px;
      border: 1px solid rgba(18, 44, 64, 0.08);
      background: rgba(255,255,255,0.9);
      color: #173346;
    }
    .hall-decision-queue-avatar {
      --hall-avatar-size: 26px;
    }
    .hall-decision-queue-item strong {
      display: block;
      font-size: 11px;
      color: #173346;
    }
    .hall-decision-queue-item span {
      display: block;
      font-size: 9px;
      color: #6a8192;
    }
    .hall-order-planner {
      display: grid;
      gap: 10px;
      padding-top: 8px;
      border-top: 1px solid rgba(18, 44, 64, 0.08);
      align-content: start;
    }
    .hall-order-planner--empty {
      gap: 12px;
      justify-items: start;
      align-content: start;
    }
    .hall-order-planner-head {
      display: grid;
      gap: 4px;
    }
    .hall-order-planner-head strong {
      font-size: 13px;
      color: #173346;
    }
    .hall-order-planner-head span {
      font-size: 12px;
      color: #6a8192;
    }
    .hall-order-list {
      display: grid;
      gap: 8px;
      align-content: start;
    }
    .hall-order-item {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      padding: 10px 12px;
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.9);
      border: 1px solid rgba(18, 44, 64, 0.08);
    }
    .hall-order-item-copy {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .hall-order-avatar {
      --hall-avatar-size: 28px;
    }
    .hall-order-item-copy strong {
      display: block;
      font-size: 13px;
      color: #173346;
    }
    .hall-order-item-copy span {
      display: block;
      font-size: 11px;
      color: #6a8192;
    }
    .hall-order-item-actions {
      display: flex;
      gap: 6px;
    }
    .hall-order-item-fields {
      flex: 1;
      min-width: 0;
      display: grid;
      gap: 8px;
    }
    .hall-order-item-fields label {
      display: grid;
      gap: 4px;
      font-size: 11px;
      color: #6a8192;
    }
    .hall-order-item-fields span {
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .hall-order-item-next {
      font-size: 11px;
      line-height: 1.4;
      color: #567084;
      margin-top: -2px;
    }
    .hall-handoff-preview {
      grid-column: 1 / -1;
      padding: 8px 10px;
      border-radius: 12px;
      background: rgba(244, 249, 255, 0.95);
      border: 1px solid rgba(18, 44, 64, 0.07);
      margin-top: 2px;
    }
    .hall-handoff-preview strong {
      color: #18384d;
      font-weight: 700;
    }
    .hall-order-textarea,
    .hall-order-input {
      width: 100%;
      border-radius: 12px;
      border: 1px solid rgba(18, 44, 64, 0.08);
      background: rgba(248, 252, 255, 0.98);
      color: #173346;
      font: inherit;
      font-size: 13px;
      line-height: 1.45;
      padding: 8px 10px;
    }
    .hall-order-textarea {
      resize: vertical;
      min-height: 56px;
    }
    .hall-order-icon {
      width: 28px;
      height: 28px;
      border-radius: 999px;
      border: 1px solid rgba(18, 44, 64, 0.1);
      background: rgba(248, 252, 255, 0.96);
      color: #173346;
      font-size: 14px;
      cursor: pointer;
    }
    .hall-order-icon:disabled {
      opacity: 0.45;
      cursor: default;
    }
    .hall-order-icon--danger {
      color: #a33434;
    }
    .hall-order-empty {
      padding: 12px;
      border-radius: 16px;
      border: 1px dashed rgba(18, 44, 64, 0.16);
      color: #6a8192;
      font-size: 13px;
      background: rgba(255, 255, 255, 0.7);
      width: min(100%, 520px);
    }
    .hall-order-planner--empty .hall-order-empty {
      min-height: 0;
      padding: 14px 16px;
      width: min(100%, 520px);
    }
    .hall-order-empty-state {
      display: grid;
      gap: 12px;
      justify-items: start;
      align-content: start;
      width: 100%;
    }
    .hall-order-available {
      display: grid;
      gap: 8px;
      align-content: start;
    }
    .hall-order-available--empty {
      width: min(100%, 760px);
    }
    .hall-order-available-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: #6a8192;
    }
    .hall-order-chip-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: flex-start;
      align-content: flex-start;
    }
    .hall-order-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 999px;
      border: 1px solid rgba(18, 44, 64, 0.08);
      background: rgba(255, 255, 255, 0.92);
      color: #173346;
      cursor: pointer;
      flex: 0 0 auto;
      align-self: flex-start;
      white-space: nowrap;
    }
    .hall-order-chip-avatar {
      --hall-avatar-size: 22px;
    }
    .hall-typing-strip {
      min-height: 28px;
      display: flex;
      align-items: center;
      margin-top: 6px;
      margin-bottom: 2px;
    }
    .hall-typing-strip[hidden] {
      display: none;
    }
    .hall-typing-row {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px 6px 8px;
      border-radius: 999px;
      background: rgba(244, 248, 252, 0.96);
      border: 1px solid rgba(18, 44, 64, 0.07);
      color: #5b7288;
      font-size: 13px;
    }
    .hall-typing-avatar-wrap {
      display: inline-flex;
      margin-right: -4px;
    }
    .hall-typing-avatar {
      --hall-avatar-size: 18px;
      box-shadow: 0 0 0 2px rgba(255,255,255,0.96);
    }
    .hall-typing-copy {
      white-space: nowrap;
    }
    .hall-typing-dots {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      margin-left: 4px;
    }
    .hall-typing-dots i {
      display: block;
      width: 4px;
      height: 4px;
      border-radius: 999px;
      background: rgba(91, 114, 136, 0.78);
      animation: hallTypingPulse 1.1s infinite ease-in-out;
    }
    .hall-typing-dots i:nth-child(2) {
      animation-delay: 0.16s;
    }
    .hall-typing-dots i:nth-child(3) {
      animation-delay: 0.32s;
    }
    @keyframes hallTypingPulse {
      0%, 80%, 100% {
        opacity: 0.34;
        transform: translateY(0);
      }
      40% {
        opacity: 1;
        transform: translateY(-2px);
      }
    }
    .hall-thread-head {
      position: sticky;
      top: 0;
      z-index: 3;
      padding-bottom: 12px;
      margin-bottom: -2px;
      background: rgba(255,255,255,0.98);
      backdrop-filter: none;
    }
    .hall-message {
      align-self: stretch;
      width: 100%;
      background: transparent;
      padding: 0;
      border: 0;
      box-shadow: none;
    }
    .hall-message-row {
      display: flex;
      gap: 12px;
      align-items: flex-end;
      max-width: min(880px, 92%);
    }
    .hall-message-avatar {
      width: 34px;
      height: 34px;
      box-shadow: inset 0 0 0 1px rgba(15, 95, 150, 0.08);
    }
    .hall-message-bubble {
      position: relative;
      min-width: 0;
      border-radius: 18px 18px 18px 12px;
      overflow: hidden;
      border: 1px solid rgba(25, 60, 86, 0.08);
      background: #ffffff;
      padding: 11px 13px 10px;
      box-shadow: none;
    }
    .hall-message-bubble::before {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: transparent;
    }
    .hall-message[data-author-type="operator"] .hall-message-row {
      margin-left: auto;
      flex-direction: row-reverse;
    }
    .hall-message[data-author-type="operator"] .hall-message-bubble {
      border-radius: 18px 18px 12px 18px;
      background: #e9f3ff;
      border-color: rgba(103, 167, 220, 0.24);
      box-shadow: none;
    }
    .hall-message[data-author-type="operator"] .hall-message-bubble::before {
      background: transparent;
    }
    .hall-message[data-author-type="operator"] .hall-message-avatar {
      background: linear-gradient(180deg, rgba(130, 190, 240, 0.16), rgba(105, 169, 227, 0.08));
    }
    .hall-message[data-author-type="operator"] .hall-message-meta,
    .hall-message[data-author-type="operator"] .hall-message-body,
    .hall-message[data-author-type="operator"] .hall-message-author {
      color: #12384f;
    }
    .hall-message[data-author-type="operator"] .hall-kind-pill {
      background: rgba(255,255,255,0.68);
      color: #3c617c;
      border-color: rgba(121, 177, 224, 0.20);
      box-shadow: none;
    }
    .hall-message[data-author-type="system"] {
      width: 100%;
    }
    .hall-message[data-author-type="system"] .hall-message-row {
      margin: 0 auto;
      justify-content: center;
      max-width: 92%;
    }
    .hall-message[data-author-type="system"] .hall-message-avatar {
      display: none;
    }
    .hall-message[data-author-type="system"] .hall-message-bubble {
      background: #f7f9fb;
      border-style: solid;
      box-shadow: none;
    }
    .hall-message--decision-inline .hall-message-row {
      max-width: min(760px, 92%);
    }
    .hall-message--decision-inline .hall-message-bubble {
      width: 100%;
      padding: 0;
      background: transparent;
      border: 0;
      box-shadow: none;
    }
    .hall-message--decision-inline .hall-decision-card {
      margin: 0 auto;
    }
    .hall-message[data-kind="decision"] {
      background: transparent;
      border-color: rgba(49, 126, 88, 0.18);
    }
    .hall-message[data-kind="handoff"] {
      background: transparent;
      border-color: rgba(176, 118, 22, 0.18);
    }
    .hall-message[data-kind="review"] {
      background: transparent;
      border-color: rgba(80, 116, 181, 0.18);
    }
    .hall-message-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 8px;
    }
    .hall-message-author {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      font-size: 12px;
      font-weight: 650;
      color: #173346;
    }
    .hall-message-body {
      font-size: 13px;
      line-height: 1.58;
      color: #173346;
    }
    .hall-message-body > :first-child {
      margin-top: 0;
    }
    .hall-message-body > :last-child {
      margin-bottom: 0;
    }
    .hall-message-body p,
    .hall-message-body ul,
    .hall-message-body ol,
    .hall-message-body blockquote,
    .hall-message-body pre {
      margin: 0 0 8px;
    }
    .hall-message-body ul,
    .hall-message-body ol {
      padding-left: 18px;
    }
    .hall-message-body code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.92em;
      padding: 0.08rem 0.35rem;
      border-radius: 8px;
      background: rgba(17, 43, 68, 0.06);
    }
    .hall-message-body a {
      color: #2c7fc3;
      text-decoration: underline;
      text-decoration-thickness: 1px;
      text-underline-offset: 2px;
    }
    .hall-md-mention {
      display: inline-block;
      padding: 0.07rem 0.46rem;
      border-radius: 999px;
      border: 1px solid rgba(41, 118, 222, 0.28);
      background: rgba(54, 132, 243, 0.14);
      color: #125ca0;
      font-weight: 800;
      letter-spacing: 0.01em;
      text-decoration: none;
    }
    .hall-message-body a.hall-md-image {
      display: block;
      width: fit-content;
      max-width: min(100%, 460px);
      margin: 10px 0;
      border-radius: 16px;
      overflow: hidden;
      border: 1px solid rgba(95, 159, 214, 0.16);
      background: rgba(255, 255, 255, 0.78);
      box-shadow: 0 10px 24px rgba(25, 53, 84, 0.08);
      text-decoration: none;
    }
    .hall-md-img {
      display: block;
      width: 100%;
      height: auto;
      max-height: 420px;
      object-fit: contain;
      background: rgba(243, 249, 255, 0.9);
    }
    .hall-message-body blockquote {
      padding-left: 10px;
      border-left: 3px solid rgba(95, 159, 214, 0.24);
      color: #47657c;
    }
    .hall-md-pre {
      overflow-x: auto;
      padding: 10px 12px;
      border-radius: 14px;
      background: rgba(17, 43, 68, 0.06);
      border: 1px solid rgba(17, 43, 68, 0.06);
    }
    .hall-md-pre code {
      display: block;
      background: transparent;
      padding: 0;
      border-radius: 0;
      font-size: 12px;
      line-height: 1.55;
    }
    .hall-message-footer {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .hall-artifact-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 6px;
    }
    .hall-artifact-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      max-width: min(100%, 420px);
      padding: 0.32rem 0.58rem;
      border-radius: 999px;
      border: 1px solid rgba(41, 118, 222, 0.16);
      background: rgba(41, 118, 222, 0.08);
      color: #1d476d;
      font-size: 11px;
      line-height: 1.25;
      text-decoration: none;
    }
    .hall-artifact-chip:hover {
      background: rgba(41, 118, 222, 0.12);
      border-color: rgba(41, 118, 222, 0.22);
    }
    .hall-artifact-chip-kind {
      flex: 0 0 auto;
      padding: 0.12rem 0.34rem;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.9);
      color: #2b6aa3;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-size: 10px;
    }
    .hall-artifact-chip-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 700;
    }
    .hall-composer-shell {
      display: grid;
      gap: 2px;
      padding-top: 0;
      border-top: 1px solid rgba(18, 44, 64, 0.08);
      background:
        linear-gradient(180deg, rgba(255,255,255,0), rgba(255,255,255,0.88) 12%, rgba(255,255,255,0.98));
    }
    .hall-composer-shell {
      position: sticky;
      bottom: 0;
      z-index: 3;
    }
    .hall-composer {
      display: grid;
      gap: 4px;
      border-radius: 16px;
      border: 1px solid rgba(18, 44, 64, 0.08);
      background: rgba(255,255,255,0.96);
      box-shadow: 0 6px 14px rgba(18, 44, 64, 0.04);
      padding: 8px 12px 6px;
    }
    .hall-composer-main {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: end;
    }
    .hall-composer textarea {
      width: 100%;
      min-height: 40px;
      max-height: 96px;
      resize: none;
      border: 0;
      outline: none;
      background: transparent;
      color: #113248;
      font: inherit;
      font-size: 13px;
      line-height: 1.45;
      padding: 0;
    }
    .hall-composer-accessory {
      display: flex;
      align-items: center;
      min-width: 0;
      padding-bottom: 0;
    }
    .hall-composer-actions {
      display: inline-flex;
      justify-content: flex-end;
      gap: 6px;
      align-items: center;
    }
    .hall-secondary-button--compact {
      padding: 7px 11px;
      font-size: 12px;
    }
    .hall-secondary-button.is-active {
      border-color: rgba(92, 176, 245, 0.42);
      background: rgba(233, 245, 255, 0.96);
      color: #18507a;
      box-shadow: 0 0 0 4px rgba(92, 176, 245, 0.10);
    }
    .hall-context-toggle {
      appearance: none;
      border: 1px solid rgba(18, 44, 64, 0.10);
      background: rgba(248, 251, 255, 0.96);
      color: #1c4056;
      border-radius: 999px;
      padding: 8px 12px;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      line-height: 1;
      white-space: nowrap;
      transition: background-color 140ms ease, box-shadow 140ms ease, border-color 140ms ease, color 140ms ease;
    }
    .hall-context-toggle::before {
      content: "i";
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border-radius: 999px;
      border: 1px solid rgba(18, 44, 64, 0.12);
      font-size: 10px;
      line-height: 1;
      font-weight: 700;
    }
    .hall-context-toggle:hover {
      box-shadow: 0 8px 18px rgba(18, 44, 64, 0.06);
      background: rgba(244, 249, 255, 0.98);
    }
    .hall-context-toggle--inline {
      flex: 0 0 auto;
    }
    .hall-button,
    .hall-secondary-button {
      appearance: none;
      border-radius: 999px;
      padding: 7px 11px;
      font: inherit;
      font-size: 12px;
      line-height: 1.2;
      white-space: nowrap;
      flex: 0 0 auto;
      cursor: pointer;
      transition: background-color 140ms ease, box-shadow 140ms ease, border-color 140ms ease, color 140ms ease;
    }
    .hall-button:hover,
    .hall-secondary-button:hover,
    .hall-mention-chip:hover {
      transform: none;
    }
    .hall-button {
      border: 1px solid rgba(102, 173, 231, 0.34);
      background: linear-gradient(180deg, rgba(92, 176, 245, 0.98), rgba(76, 163, 237, 0.98));
      color: #fff;
      box-shadow: 0 8px 18px rgba(71, 154, 224, 0.16);
    }
    .hall-button:hover {
      background: linear-gradient(180deg, rgba(99, 181, 247, 0.98), rgba(82, 168, 241, 0.98));
      box-shadow: 0 10px 20px rgba(71, 154, 224, 0.18);
    }
    .hall-secondary-button {
      border: 1px solid rgba(18, 44, 64, 0.10);
      background: rgba(248, 251, 255, 0.96);
      color: #1c4056;
      list-style: none;
    }
    .hall-secondary-button:hover {
      background: rgba(244, 249, 255, 0.98);
      box-shadow: 0 8px 18px rgba(18, 44, 64, 0.05);
    }
    .hall-secondary-button--accent {
      border-color: rgba(102, 173, 231, 0.34);
      background: linear-gradient(180deg, rgba(92, 176, 245, 0.98), rgba(76, 163, 237, 0.98));
      color: #fff;
      box-shadow: 0 8px 18px rgba(71, 154, 224, 0.16);
    }
    .hall-secondary-button--accent:hover {
      background: linear-gradient(180deg, rgba(99, 181, 247, 0.98), rgba(82, 168, 241, 0.98));
      box-shadow: 0 10px 20px rgba(71, 154, 224, 0.18);
    }
    .hall-secondary-button--icon {
      width: 34px;
      height: 34px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      line-height: 1;
    }
    .hall-secondary-button::-webkit-details-marker {
      display: none;
    }
    .hall-button--send {
      min-width: 72px;
      justify-self: end;
    }
    .hall-action-menu {
      position: relative;
    }
    .hall-action-menu--thread summary {
      width: 32px;
      height: 32px;
      font-size: 18px;
    }
    .hall-action-menu[open] summary {
      box-shadow: 0 10px 22px rgba(18, 44, 64, 0.08);
    }
    .hall-action-menu-panel {
      position: absolute;
      left: 0;
      bottom: calc(100% + 8px);
      display: grid;
      gap: 6px;
      min-width: 180px;
      padding: 8px;
      border-radius: 18px;
      border: 1px solid rgba(18, 44, 64, 0.10);
      background: rgba(255,255,255,0.98);
      box-shadow: 0 18px 38px rgba(18, 44, 64, 0.12);
      z-index: 4;
    }
    .hall-action-menu-panel--thread {
      left: auto;
      right: 0;
      min-width: 156px;
    }
    .hall-menu-button {
      appearance: none;
      border: 0;
      background: rgba(245, 249, 253, 0.96);
      color: #16374d;
      text-align: left;
      border-radius: 14px;
      padding: 10px 12px;
      cursor: pointer;
      font: inherit;
      font-size: 13px;
    }
    .hall-menu-button:hover {
      background: rgba(233, 243, 251, 0.98);
    }
    .hall-menu-button--danger {
      color: #9b2e2e;
      background: rgba(255, 246, 246, 0.98);
    }
    .hall-menu-button--danger:hover {
      background: rgba(255, 238, 238, 0.98);
    }
    .hall-inline-mentions {
      display: grid;
      gap: 8px;
    }
    .hall-mention-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .hall-mention-list--inline {
      flex-wrap: nowrap;
      gap: 5px;
      max-height: none;
      overflow-x: auto;
      overflow-y: hidden;
      padding-bottom: 0;
      margin-bottom: -1px;
      scrollbar-width: thin;
    }
    .hall-mention-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      border: 1px solid rgba(18, 44, 64, 0.08);
      border-radius: 999px;
      background: rgba(250, 252, 255, 0.96);
      padding: 3px 7px 3px 3px;
      cursor: pointer;
      text-align: left;
      color: #12344a;
      min-width: 0;
      flex: none;
    }
    .hall-mention-avatar {
      width: 18px;
      height: 18px;
    }
    .hall-agent-avatar .agent-pixel-canvas,
    .hall-pixel-avatar .agent-pixel-canvas {
      width: 100%;
      height: 100%;
      display: block;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
    }
    .hall-mention-copy {
      display: grid;
      gap: 1px;
      min-width: 0;
    }
    .hall-mention-chip strong {
      display: block;
      font-size: 10px;
      line-height: 1.2;
    }
    .hall-flash {
      min-height: 0;
      font-size: 11px;
      line-height: 1.35;
      color: #36556c;
      background: rgba(239, 247, 255, 0.92);
      border: 1px solid rgba(17, 118, 184, 0.12);
      border-radius: 12px;
      padding: 8px 10px;
    }
    .hall-flash:empty {
      display: none;
    }
    .hall-detail-group {
      border-radius: 18px;
      border: 1px solid rgba(18, 44, 64, 0.08);
      background: rgba(255,255,255,0.92);
      padding: 14px 15px;
    }
    .hall-detail-group h4 {
      margin: 0 0 10px;
      font-size: 13px;
      letter-spacing: -0.01em;
      color: #19364b;
    }
    .hall-empty {
      border-radius: 24px;
      border: 1px dashed rgba(18, 44, 64, 0.16);
      padding: 22px 18px;
      background: rgba(252, 253, 255, 0.98);
      color: #687b8c;
      font-size: 13px;
      line-height: 1.7;
      display: grid;
      gap: 6px;
      align-content: center;
    }
    .hall-empty strong {
      font-size: 14px;
      line-height: 1.3;
      color: #19364b;
    }
    .hall-empty span {
      display: block;
    }
    .hall-empty--sidebar {
      min-height: 88px;
      padding: 16px 14px;
      border-radius: 18px;
      font-size: 12px;
      line-height: 1.55;
    }
    .hall-empty--chat {
      min-height: 180px;
      place-items: center;
      text-align: center;
    }
    .hall-empty--draft {
      min-height: 220px;
      border-style: solid;
      border-color: rgba(17, 118, 184, 0.12);
      background:
        linear-gradient(180deg, rgba(246, 251, 255, 0.98), rgba(251, 253, 255, 0.96));
    }
    .hall-empty-hero {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 4px;
    }
    .hall-empty-avatar {
      width: 56px;
      height: 56px;
      box-shadow: inset 0 0 0 1px rgba(15, 95, 150, 0.08);
    }
    .hall-empty-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: center;
      margin-top: 4px;
    }
    .hall-empty-action {
      appearance: none;
      border: 1px solid rgba(18, 44, 64, 0.10);
      background: rgba(255,255,255,0.96);
      color: #16374d;
      border-radius: 999px;
      padding: 8px 12px;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      line-height: 1.2;
      box-shadow: 0 8px 18px rgba(18, 44, 64, 0.04);
      transition: background-color 140ms ease, box-shadow 140ms ease, border-color 140ms ease, color 140ms ease;
    }
    .hall-empty-action:hover {
      box-shadow: 0 10px 20px rgba(18, 44, 64, 0.06);
      background: rgba(245, 249, 255, 0.98);
    }
    .hall-thread-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: #0f5f96;
      text-decoration: none;
      font-size: 12px;
      font-weight: 600;
    }
    .hall-thread-link:hover {
      text-decoration: underline;
    }
    .hall-roster {
      display: grid;
      gap: 8px;
    }
    .hall-roster-item {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 8px;
      align-items: center;
      min-width: 0;
    }
    .hall-roster-avatar {
      width: 28px;
      height: 28px;
    }
    .hall-roster-copy {
      display: grid;
      gap: 1px;
      min-width: 0;
    }
    .hall-roster-copy strong {
      font-size: 12px;
      line-height: 1.2;
      color: #173346;
    }
    .hall-roster-copy span {
      font-size: 11px;
      line-height: 1.3;
      color: #6c8192;
    }
    @media (max-width: 560px) {
      .collaboration-hall-card {
        min-height: auto;
        height: auto;
        max-height: none;
      }
      .hall-toolbar,
      .hall-layout {
        grid-template-columns: 1fr;
      }
      .hall-pane--thread {
        height: auto;
        min-height: 640px;
      }
      .hall-thread {
        max-height: 560px;
      }
      .hall-composer-main {
        grid-template-columns: 1fr;
      }
      .hall-composer-actions {
        justify-content: space-between;
      }
      .hall-pane-head .meta,
      .hall-thread-head .meta {
        text-align: left;
      }
      .hall-pane--context {
        position: static;
        width: auto;
        min-height: 0;
        transform: none !important;
        opacity: 1 !important;
        pointer-events: auto !important;
        box-shadow:
          0 16px 40px rgba(17, 43, 68, 0.07),
          inset 0 1px 0 rgba(255,255,255,0.75) !important;
      }
    }
  `;
}
