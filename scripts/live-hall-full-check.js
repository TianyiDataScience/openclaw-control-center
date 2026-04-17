const { chromium } = require("playwright");

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  const errors = [];
  const scanPrompt = `full-check-${Date.now()} 请先扫描 control-center 代码，找出 hall-chat 的 3 个关键入口文件，并说明每个文件负责什么。`;
  const scanPrefix = scanPrompt.split(" ")[0];

  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console:${message.text()}`);
  });

  await page.goto("http://127.0.0.1:4310/?section=hall-chat", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForSelector("[data-collaboration-hall-root]", { timeout: 30000 });

  // 1) Start a fresh task and verify discussion + typing lifecycle.
  await page.locator("[data-hall-compose-task]").click();
  await page
    .locator("[data-hall-composer-textarea]")
    .fill(scanPrompt);
  await page.locator("[data-hall-send-reply]").click();

  let selectedFreshThread = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const headerTitle = await page
      .locator("[data-hall-thread-title]")
      .textContent()
      .catch(() => "");
    if (String(headerTitle || "").includes(scanPrefix)) {
      selectedFreshThread = true;
      break;
    }
    const createdThreadCard = page
      .locator("[data-task-card-id]")
      .filter({ hasText: scanPrefix })
      .first();
    if (await createdThreadCard.count().catch(() => 0)) {
      await createdThreadCard.click();
      await wait(500);
      const nextHeaderTitle = await page
        .locator("[data-hall-thread-title]")
        .textContent()
        .catch(() => "");
      if (String(nextHeaderTitle || "").includes(scanPrefix)) {
        selectedFreshThread = true;
        break;
      }
    }
    await wait(1500);
  }
  if (!selectedFreshThread) throw new Error("newly created thread never became selected");

  let typingSeen = false;
  let planButtonSeen = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const typingTexts = await page.locator("[data-hall-typing-strip]").allTextContents().catch(() => []);
    if (typingTexts.some((text) => String(text || "").trim().length > 0)) typingSeen = true;
    if (await page.locator("[data-hall-plan-order]").count().catch(() => 0)) {
      planButtonSeen = true;
      break;
    }
    await wait(3000);
  }
  if (!typingSeen) throw new Error("typing strip never appeared after creating a task");
  if (!planButtonSeen) throw new Error("plan-order button never appeared");

  // 2) Planner opens as a dedicated editing surface and can scroll.
  await page.locator("[data-hall-plan-order]").first().click();
  await page.waitForSelector("[data-hall-order-save]", { timeout: 15000 });

  const plannerState = await page.evaluate(() => {
    const planner = document.querySelector(".hall-order-planner");
    const composer = document.querySelector(".hall-composer-shell");
    const thread = document.querySelector(".hall-thread");
    const saveButton = document.querySelector("[data-hall-order-save]");
    const emptyState = document.querySelector(".hall-order-empty");
    return {
      plannerOverflow: planner ? getComputedStyle(planner).overflowY : null,
      plannerHeight: planner ? planner.getBoundingClientRect().height : null,
      composerDisplay: composer ? getComputedStyle(composer).display : null,
      threadDisplay: thread ? getComputedStyle(thread).display : null,
      saveHeight: saveButton ? saveButton.getBoundingClientRect().height : null,
      emptyHeight: emptyState ? emptyState.getBoundingClientRect().height : null,
    };
  });

  if (plannerState.composerDisplay !== "none") throw new Error("composer should be hidden while planning");
  if (plannerState.threadDisplay !== "none") throw new Error("thread should be hidden while planning");
  if ((plannerState.saveHeight ?? 0) > 56) throw new Error("planner buttons are stretched too tall in empty state");
  if ((plannerState.emptyHeight ?? 0) > 120) throw new Error("empty planner state is still stretched too tall");

  // 2b) Long planner should scroll.
  for (const participantId of ["coq", "main", "monkey", "otter", "pandas", "tiger"]) {
    const chip = page.locator(`[data-hall-order-add="${participantId}"]`).first();
    if (await chip.count()) await chip.click();
  }
  const plannerScrolled = await page.evaluate(async () => {
    const card = document.querySelector('.hall-decision-card--planner');
    if (!card) return false;
    const before = card.scrollTop;
    card.scrollTop = before + 240;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return card.scrollTop > before;
  });
  if (!plannerScrolled) throw new Error("long planner did not scroll");
  await page.locator("[data-hall-order-cancel]").click();
  await wait(500);
  await page.locator("[data-hall-plan-order]").first().click();
  await page.waitForSelector("[data-hall-order-save]", { timeout: 15000 });

  // 3) Configure execution order.
  for (const participantId of ["pandas", "main", "otter"]) {
    const chip = page.locator(`[data-hall-order-add="${participantId}"]`).first();
    if (await chip.count()) await chip.click();
  }

  await page
    .locator('[data-hall-item-task="pandas"]')
    .fill("扫描 control-center 代码，贴出 3 个真实文件路径，并说明每个文件负责什么。");
  await page.locator('[data-hall-item-handoff-to="pandas"]').selectOption("main");
  await page
    .locator('[data-hall-item-handoff="pandas"]')
    .fill("贴完 3 个文件路径和职责后交给 @main 复核。");

  await page
    .locator('[data-hall-item-task="main"]')
    .fill("只复核 pandas 列出的文件是不是关键入口，不重做扫描。");
  await page.locator('[data-hall-item-handoff-to="main"]').selectOption("otter");
  await page
    .locator('[data-hall-item-handoff="main"]')
    .fill("确认关键入口没问题后交给 @otter 只挑 must-fix。");

  await page.locator('[data-hall-item-task="otter"]').fill("只挑 must-fix，没有问题就请老板评审。");
  await page.locator('[data-hall-item-handoff-to="otter"]').selectOption("");
  await page.locator('[data-hall-item-handoff="otter"]').fill("没有 must-fix 就请老板评审。");

  await page.locator("[data-hall-order-save]").click();
  await wait(2500);

  const startButton = page.locator("[data-hall-start-execution]").first();
  if (!(await startButton.count())) throw new Error("start execution button missing after saving order");

  // 4) Execution chain should produce visible repo-scan output and no wrong handoff warning.
  await startButton.click();

  let foundPaths = false;
  let wrongHandoffWarning = false;
  let executionSettled = false;
  let visibleMessages = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await wait(5000);
    visibleMessages = await page.locator(".hall-message .hall-message-body").evaluateAll((nodes) =>
      nodes.map((node) => ({
        text: node.textContent || "",
        clamp: getComputedStyle(node).webkitLineClamp,
        overflow: getComputedStyle(node).overflow,
        whiteSpace: getComputedStyle(node).whiteSpace,
      })),
    );
    const texts = visibleMessages.map((message) => message.text);
    foundPaths = texts.some((text) =>
      /src\/ui\/collaboration-hall\.ts|src\/runtime\/collaboration-hall-orchestrator\.ts|src\/runtime\/hall-runtime-dispatch\.ts/.test(text),
    );
    wrongHandoffWarning = texts.some((text) => text.includes("Handoff moved to"));
    const consoleText = await page
      .locator("[data-hall-decision-panel]")
      .allTextContents()
      .then((items) => items.join(" "))
      .catch(() => "");
    executionSettled = foundPaths && !/需要人类审核|needs human review|执行中|in progress/i.test(consoleText);
    if (executionSettled) break;
  }

  if (!foundPaths) throw new Error("repo scan deliverable never became visible");
  if (wrongHandoffWarning) throw new Error("wrong handoff warning became visible");
  if (!executionSettled) {
    const debug = await page.evaluate(() => ({
      panelText: document.querySelector("[data-hall-decision-panel]")?.textContent || "",
      bodyText: document.body.innerText.slice(0, 3000),
    }));
    console.error(JSON.stringify({ executionNeverSettled: debug }, null, 2));
    throw new Error("execution chain never settled before the follow-up");
  }

  const unclampedMessages = visibleMessages.every((message) => {
    const clamp = String(message.clamp || "").trim();
    return clamp === "" || clamp === "none";
  });
  if (!unclampedMessages) throw new Error("visible execution messages are still clamped");
  const textDump = visibleMessages.map((message) => message.text).join("\n");
  for (const forbidden of ["[tool]", "thinking", "hall-structured", "LOCAL_API_TOKEN", "language is not defined"]) {
    if (textDump.includes(forbidden)) throw new Error(`forbidden leak visible: ${forbidden}`);
  }

  // 5) Follow-up after execution should reopen discussion and get another reply.
  await page.locator("[data-hall-composer-textarea]").fill("继续讨论吧，下一版怎么展开得更清楚？");
  await page.locator("[data-hall-send-reply]").click();

  let repliedAfterExecution = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await wait(3000);
    const authors = await page.locator(".hall-message .hall-message-author strong").allTextContents().catch(() => []);
    const nonOperatorCount = authors.filter((name) => name !== "Operator").length;
    if (nonOperatorCount >= 4) {
      repliedAfterExecution = true;
      break;
    }
  }
  if (!repliedAfterExecution) throw new Error("follow-up after execution got no reply");

  // 6) A new round can be planned and started again after the follow-up.
  await page.locator("[data-hall-plan-order]").first().click();
  await page.waitForSelector("[data-hall-order-save]", { timeout: 15000 });
  await page.locator("[data-hall-order-cancel]").click().catch(() => {});
  await wait(400);
  await page.locator("[data-hall-plan-order]").first().click();
  await page.waitForSelector("[data-hall-order-save]", { timeout: 15000 });
  for (const participantId of ["main", "otter"]) {
    const chip = page.locator(`[data-hall-order-add="${participantId}"]`).first();
    if (await chip.count()) await chip.click();
  }
  await page.locator('[data-hall-item-task="main"]').fill("把这一版继续讨论收成第二轮可执行开头。");
  await page.locator('[data-hall-item-handoff-to="main"]').selectOption("otter");
  await page.locator('[data-hall-item-handoff="main"]').fill("收住后交给 @otter。");
  await page.locator('[data-hall-item-task="otter"]').fill("只挑 must-fix。");
  await page.locator('[data-hall-item-handoff-to="otter"]').selectOption("");
  await page.locator('[data-hall-item-handoff="otter"]').fill("没有 must-fix 就请老板评审。");
  await page.locator("[data-hall-order-save]").click();
  await wait(2000);
  const secondStartExists = await page.locator("[data-hall-start-execution]").count().catch(() => 0);
  if (!secondStartExists) {
    const debug = await page.evaluate(() => {
      const panel = document.querySelector("[data-hall-decision-panel]");
      const consoleNode = panel?.querySelector("[data-hall-current-console]");
      const selectedCard = document.querySelector('[data-task-card-id][aria-current="page"], [data-task-card-id][aria-current="true"]');
      return {
        panelText: panel?.textContent || "",
        consoleText: consoleNode?.textContent || "",
        selectedCardText: selectedCard?.textContent || "",
        bodyText: document.body.innerText.slice(0, 6000),
      };
    });
    console.error(JSON.stringify({ secondRoundDebug: debug }, null, 2));
    throw new Error("second-round start execution button missing after replanning");
  }

  console.log(
    JSON.stringify(
      {
        errors,
        typingSeen,
        planButtonSeen,
        plannerState,
        plannerScrolled,
        foundPaths,
        wrongHandoffWarning,
        secondStartExists,
        lastMessages: visibleMessages.slice(-4),
        finalAuthors: await page.locator(".hall-message .hall-message-author strong").allTextContents().catch(() => []),
      },
      null,
      2,
    ),
  );

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
