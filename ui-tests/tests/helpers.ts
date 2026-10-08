import { expect, Locator, Page } from '@playwright/test';

export const RIGHT_PANEL = '#elephant-lab-right-panel';

// Brings the Elephant Lab sidebar tab to the front (e.g. if the Debugger stole focus).
// Retries, because the 'elephant-lab:open' command resolves before the panel is attached.
export async function ensureElephantLabActive(page: Page) {
  const elephantLabTab = page.getByRole('tab', { name: 'Elephant Lab', exact: true });
  const rightPanel = page.locator(RIGHT_PANEL);

  await expect(async () => {
    if (await elephantLabTab.getAttribute('aria-selected', { timeout: 1000 }) !== 'true') {
      await elephantLabTab.click({ timeout: 1000 });
    }
    await expect(elephantLabTab).toHaveAttribute('aria-selected', 'true', { timeout: 1000 });
    await expect(rightPanel).not.toHaveClass(/lm-mod-hidden/, { timeout: 1000 });
  }).toPass({ timeout: 30000 });
}

// Shuts down kernels left over from previous tests, so they don't slow down new ones
export async function shutdownAllKernels(page: Page) {
  await page.waitForFunction(() => window.jupyterapp !== undefined, null, { timeout: 30000 });
  await page.evaluate(async () => {
    await window.jupyterapp.serviceManager.sessions.shutdownAll();
  });
}

// Waits until a tree row is visible, re-activating Elephant Lab in case the
// Debugger sidebar took focus after the kernel started
export async function expectTreeRowVisible(page: Page, row: Locator, timeout = 30000) {
  await expect(async () => {
    await ensureElephantLabActive(page);
    await expect(row).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout });
}

// Opens Elephant Lab for the currently active notebook
export async function openElephantLab(page: Page) {
  await page.evaluate(async () => {
    await window.jupyterapp.commands.execute('elephant-lab:open');
  });
  await ensureElephantLabActive(page);
}

// All rows of the Neo tree (rendered by elephant_lab_tree.py as .jup-row elements)
export function treeRows(page: Page): Locator {
  return page.locator(`${RIGHT_PANEL} .jup-tree .jup-row[data-node-id]`);
}

// Tree rows whose own label (not their children) matches the given text
export function treeRow(page: Page, text: string | RegExp): Locator {
  return treeRows(page).filter({ hasText: text });
}

export const SELECTED = /jup-selected/;

// Containers with 5+ children are collapsed by default, which hides their rows.
// Turns on "Expand all containers" (idempotent) and waits for the tree to re-render.
export async function expandAllContainers(page: Page) {
  const expandToggle = page.locator(`${RIGHT_PANEL} label[title="Expand all containers"]`);
  await ensureElephantLabActive(page);
  if (await expandToggle.getAttribute('data-checked') !== 'true') {
    await expandToggle.click();
  }
  await expect(expandToggle).toHaveAttribute('data-checked', 'true');
  await expect(page.locator(`${RIGHT_PANEL} .jup-tree .jup-children:not(.jup-open)`))
    .toHaveCount(0, { timeout: 10000 });
}

// Clicks a tree row and waits until it is shown as selected. The click handler
// defers selection by 250ms (to distinguish double-clicks) before notifying the kernel.
export async function selectTreeRow(page: Page, row: Locator) {
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await expect(row).toHaveClass(SELECTED, { timeout: 5000 });
  // Give the kernel request time to start before waiting for idle again
  await page.waitForTimeout(500);
  await expect(page.getByRole('button', { name: /Python 3.*Idle/ })).toBeVisible({ timeout: 20000 });
}
