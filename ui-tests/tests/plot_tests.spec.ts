import { test, expect } from '@playwright/test';
import { ensureElephantLabActive, expandAllContainers, expectTreeRowVisible, openElephantLab, shutdownAllKernels, treeRow, SELECTED } from './helpers';
// TODO: Move other plot tests here as well

// Helper function to capture plot data for comparison
async function getPlotData(plotContainer: any) {
  return await plotContainer.evaluate((el: any) => {
    if (el.data && el.layout) {
      return {
        source: 'plotly',
        numTraces: el.data.length,
        xAxisTitle: el.layout?.xaxis?.title?.text || '',
        yAxisTitle: el.layout?.yaxis?.title?.text || '',
        // Capture actual data points. plotly.py >= 6 sends numpy arrays base64-encoded
        // ({dtype, bdata}) in el.data, so read the decoded arrays from el._fullData.
        firstTraceXLength: (el._fullData?.[0] ?? el.data?.[0])?.x?.length || 0,
        firstTraceYLength: (el._fullData?.[0] ?? el.data?.[0])?.y?.length || 0,
        // Get marker/line colors that might change with Dark mode
        firstTraceColor: el.data?.[0]?.marker?.color || el.data?.[0]?.line?.color || 'unknown',
      };
    }

    const svg = el.querySelector('svg');
    if (svg) {
      return {
        source: 'svg',
        svgHash: svg.outerHTML.length,
        svgChildCount: svg.children.length,
      };
    }

    // Fallback: Get bounding box 
    const rect = el.getBoundingClientRect();
    return {
      source: 'boundingbox',
      width: rect.width,
      height: rect.height,
    };
  });
}

// This function is explicitly used to test visual changes in the plot (like dark mode)
// where the data does not change but the styling does
async function getPlotVisualHash(plotContainer: any) {
  return await plotContainer.evaluate((el: any) => {
    const svg = el.querySelector('svg');
    if (svg) {
      const backgroundColor = window.getComputedStyle(el).backgroundColor;
      const styles = window.getComputedStyle(svg);
      return `${backgroundColor}|${svg.outerHTML.substring(0, 300)}`;
    }
    return el.outerHTML.substring(0, 300);
  });
}

test.describe('Elephant Lab: Explore Tab Toggles', () => {
  test.setTimeout(120000);

  test.beforeEach(async ({ page }) => {
    // 1. Navigate to JupyterLab
    await page.goto('http://localhost:8888/lab?reset');
    await page.waitForSelector('#jupyterlab-splash', { state: 'detached', timeout: 30000 });
    await shutdownAllKernels(page);

    // 2. Wait for kernel to be ready
    await page.waitForTimeout(1000);

    // 3. Open a new Notebook via menu
    await page.getByRole('menuitem', { name: 'File' }).click();
    await page.locator('.lm-Menu-itemLabel', { hasText: /^New$/ }).click();
    await page.locator('.lm-Menu-itemLabel', { hasText: /^Notebook$/ }).click();

    // Handle kernel selection dialog if it appears
    const selectBtn = page.getByRole('button', { name: 'Select' });
    try {
      await selectBtn.waitFor({ state: 'visible', timeout: 5000 });
      await selectBtn.click();
    } catch (e) {
      // No dialog, proceed
    }
    await page.waitForSelector('.jp-Notebook-cell', { timeout: 20000 });

    // 4. Create test data in notebook
    const neoCode = `
from neo.core import (
    Block, Segment, AnalogSignal, SpikeTrain, Epoch, Event,
    IrregularlySampledSignal, ImageSequence, ChannelView, Group,
    CircularRegionOfInterest, PolygonRegionOfInterest, RectangularRegionOfInterest
)
import quantities as pq
import numpy as np

test_block = Block(name="TestBlock")
test_block.segments.append(Segment(name="my segment"))
test_block.segments[0].analogsignals.append(
    AnalogSignal([1, 2, 3], name="my analogsignal", t_stop=4, units='s', 
                 sampling_rate=1*pq.Hz, id='Unit 1', channel_id=1, unit_id=0, unit_tag='unclassified')
)

test_block.segments[0].spiketrains.append(
    SpikeTrain([1, 2, 3], name="my_spiketrain", t_stop=4, units='s', 
               id='Unit 1', channel_id=1, unit_id=0, unit_tag='unclassified')
)

test_block.segments[0].spiketrains.append(
    SpikeTrain([1, 2, 3, 4], name="my_spiketrain2", t_stop=4, units='s', 
               id='Unit 2', channel_id=1, unit_id=0, unit_tag='unclassified')
)

test_block.segments[0].epochs.append(
    Epoch(times=[0, 1, 2]*pq.s, durations=[0.5, 0.5, 0.5]*pq.s, labels=['a', 'b', 'c'], 
          name="my epoch", id='Unit 1', channel_id=1, unit_id=0, unit_tag='unclassified')
)

test_block.segments[0].events.append(
    Event(times=[0.5, 1.5, 2.5]*pq.s, labels=['x', 'y', 'z'], 
          name="my event", id='Unit 1', channel_id=1, unit_id=0, unit_tag='unclassified')
)

test_block.segments[0].irregularlysampledsignals.append(
    IrregularlySampledSignal(signal=[1.1, 2.2, 3.3], times=[0, 1, 2]*pq.s, units='V', 
                             name="my irregularsignal", id='Unit 1', channel_id=1, unit_id=0, unit_tag='unclassified')
)

img_sequence_array = [[[column for column in range(20)]for row in range(20)]
                        for frame in range(10)]

test_block.segments[0].imagesequences.append(
    ImageSequence(img_sequence_array, units='V',
                               sampling_rate=1 * pq.Hz,
                               spatial_scale=1 * pq.micrometer,
                               name="my imagesequence")
)

my_group = Group(name="my group", id='Unit 1', channel_id=1, unit_id=0, unit_tag='unclassified')
test_block.groups.append(my_group)

my_channelview = ChannelView(test_block.segments[0].analogsignals[0], index=[0], 
                             name="my channelview", id='Unit 1', channel_id=1, unit_id=0, unit_tag='unclassified')

my_imageseq = test_block.segments[0].imagesequences[0]

print("Created:", test_block.name)
      `.trim();

    await page.evaluate((code) => {
      const widgets = Array.from(window.jupyterapp.shell.widgets('main'));
      const notebookWidget = widgets.find((w: any) => w.sessionContext && w.model && w.model.cells);
      if (notebookWidget && notebookWidget.model.cells.get(0).sharedModel) {
        notebookWidget.model.cells.get(0).sharedModel.setSource(code);
      }
    }, neoCode);

    // Execute cell
    const firstCell = page.locator('.jp-Notebook-cell').first();
    await firstCell.click();

    await page.evaluate(async () => {
      void window.jupyterapp.commands.execute('notebook:run-cell-and-select-next');
    });

    // Wait for output
    await expect(async () => {
      const outputArea = firstCell.locator('.jp-OutputArea-child').first();
      await expect(outputArea).toBeVisible({ timeout: 2000 });
      await expect(outputArea).toContainText('Created: TestBlock', { timeout: 2000 });
    }).toPass({ timeout: 60000 });

    // 5. Activate Elephant Lab sidebar
    await openElephantLab(page);

    // 6. Ensure tree is populated
    await expectTreeRowVisible(page, treeRow(page, 'TestBlock'));
    await expandAllContainers(page);
  });

  // Clean up after each test
  test.afterEach(async ({ page }) => {
    const rightPanel = page.locator('#elephant-lab-right-panel');

    const darkToggle = rightPanel.getByRole('button', { name: /Dark/i }).first();
    const darkPressed = await darkToggle.getAttribute('aria-pressed', { timeout: 2000 }).catch(() => null);
    if (darkPressed === 'true') {
      await darkToggle.click();
      await page.waitForTimeout(300);
    }

    // Reset Overlap mode
    const overlapToggle = rightPanel.getByRole('button', { name: /Overlap/i }).first();
    const overlapPressed = await overlapToggle.getAttribute('aria-pressed', { timeout: 2000 }).catch(() => null);
    if (overlapPressed === 'true') {
      await overlapToggle.click();
      await page.waitForTimeout(300);
    }

    // Reset Zero Based mode
    const zeroBasedToggle = rightPanel.getByRole('button', { name: /Zero Based/i }).first();
    const zeroBasedPressed = await zeroBasedToggle.getAttribute('aria-pressed', { timeout: 2000 }).catch(() => null);
    if (zeroBasedPressed === 'true') {
      await zeroBasedToggle.click();
      await page.waitForTimeout(300);
    }
  });

  // --- TEST 1: Dark Mode Toggle ---
  test('should toggle Dark mode in Explore tab for AnalogSignal', async ({ page }) => {
    await ensureElephantLabActive(page);

    const rightPanel = page.locator('#elephant-lab-right-panel');

    // 1. Select an AnalogSignal node
    const analogSignalNode = treeRow(page, 'my analogsignal').first();

    await analogSignalNode.scrollIntoViewIfNeeded();
    await analogSignalNode.click();
    await page.waitForTimeout(300);

    // 2. Switch to Explore tab
    const exploreTab = rightPanel.getByRole('tab', { name: 'Explore', exact: true });
    await exploreTab.click();
    await page.waitForTimeout(800);

    await ensureElephantLabActive(page);

    // 3. Verify plot is visible
    const plotContainer = rightPanel.locator('div[data-plot], .plotly-graph-div, .js-plotly-plot').first();
    await expect(plotContainer).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(500);

    // 4. Get the Dark toggle button
    const darkToggle = rightPanel.getByRole('button', { name: /Dark/i }).first();
    await expect(darkToggle).toBeVisible({ timeout: 5000 });

    // Get initial pressed state
    const initialPressed = await darkToggle.getAttribute('aria-pressed');

    // 5. Click the Dark toggle
    await darkToggle.click();
    await page.waitForTimeout(500);

    // 6. Verify the toggle state changed
    const newPressed = await darkToggle.getAttribute('aria-pressed');
    expect(newPressed).not.toBe(initialPressed);

    // 7. Verify plot is still visible
    await expect(plotContainer).toBeVisible({ timeout: 5000 });

  });

  // --- TEST 2: Overlap Toggle ---
  test('should toggle Overlap mode in Explore tab for AnalogSignal', async ({ page }) => {
    await ensureElephantLabActive(page);

    const rightPanel = page.locator('#elephant-lab-right-panel');

    // 1. Select an AnalogSignal node
    const analogSignalNode = treeRow(page, 'my analogsignal').first();

    await analogSignalNode.scrollIntoViewIfNeeded();
    await analogSignalNode.click();
    await page.waitForTimeout(300);

    // 2. Switch to Explore tab
    const exploreTab = rightPanel.getByRole('tab', { name: 'Explore', exact: true });
    await exploreTab.click();
    await page.waitForTimeout(800);

    // 3. Verify plot is visible
    const plotContainer = rightPanel.locator('div[data-plot], .plotly-graph-div, .js-plotly-plot').first();
    await expect(plotContainer).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(500);

    // Capture initial plot data for later comparison
    const initialPlotData = await getPlotData(plotContainer);

    // 4. Get the Overlap toggle button
    const overlapToggle = rightPanel.getByRole('button', { name: /Overlap/i }).first();
    await expect(overlapToggle).toBeVisible({ timeout: 5000 });

    // Get initial pressed state
    const initialPressed = await overlapToggle.getAttribute('aria-pressed');

    // 5. Click the Overlap toggle
    await overlapToggle.click();
    await page.waitForTimeout(500);

    // 6. Verify the toggle state changed
    const newPressed = await overlapToggle.getAttribute('aria-pressed');
    expect(newPressed).not.toBe(initialPressed);

    const newPlotData = await getPlotData(plotContainer);

    // For Overlap mode, the layout should change but data points remain
    expect(newPlotData).toBeDefined();

    // 7. Verify plot is still visible and re-rendered
    await expect(plotContainer).toBeVisible({ timeout: 5000 });
    const box = await plotContainer.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.height).toBeGreaterThan(50);

    if (initialPlotData.source === 'plotly' && newPlotData.source === 'plotly') {
      expect(newPlotData.numTraces).toBe(initialPlotData.numTraces);
    }

  });

  // --- TEST 3: Zero Based Toggle ---
  test('should toggle Zero Based mode in Explore tab for AnalogSignal', async ({ page }) => {
    await ensureElephantLabActive(page);

    const rightPanel = page.locator('#elephant-lab-right-panel');

    // 1. Select an AnalogSignal node
    const analogSignalNode = treeRow(page, 'my analogsignal').first();

    await analogSignalNode.scrollIntoViewIfNeeded();
    await analogSignalNode.click();
    await page.waitForTimeout(300);

    // 2. Switch to Explore tab
    const exploreTab = rightPanel.getByRole('tab', { name: 'Explore', exact: true });
    await exploreTab.click();
    await page.waitForTimeout(800);

    // 3. Verify plot is visible
    const plotContainer = rightPanel.locator('div[data-plot], .plotly-graph-div, .js-plotly-plot').first();
    await expect(plotContainer).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(500);

    // Capture initial plot data
    const initialPlotData = await getPlotData(plotContainer);

    // 4. Get the Zero Based toggle button
    const zeroBasedToggle = rightPanel.getByRole('button', { name: /Zero Based/i }).first();
    await expect(zeroBasedToggle).toBeVisible({ timeout: 5000 });

    // Get initial pressed state
    const initialPressed = await zeroBasedToggle.getAttribute('aria-pressed');

    // 5. Click the Zero Based toggle
    await zeroBasedToggle.click();
    await page.waitForTimeout(500);

    // 6. Verify the toggle state changed
    const newPressed = await zeroBasedToggle.getAttribute('aria-pressed');
    expect(newPressed).not.toBe(initialPressed);

    if (initialPlotData.source === 'plotly') {
      // Verify the data is still there once the plot has re-rendered
      await expect.poll(async () => {
        const data = await getPlotData(plotContainer);
        return Math.min(data.firstTraceXLength ?? 0, data.firstTraceYLength ?? 0);
      }, { timeout: 10000 }).toBeGreaterThan(0);
    }

    // 7. Verify plot is still visible and re-rendered
    await expect(plotContainer).toBeVisible({ timeout: 5000 });
    const box = await plotContainer.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.height).toBeGreaterThan(50);

  });

  test('should re-render plots in the Explore tab when colormap is changed', async ( { page }) => {
    await ensureElephantLabActive(page);
  
    // 1. Select the "ImageSequence" node in the tree
    const imagesequenceNode = treeRow(page, 'my imagesequence').first();
  
    await expect(async () => {
      await imagesequenceNode.waitFor({ state: 'visible', timeout: 3000 });
      await imagesequenceNode.click({ timeout: 3000 });
    }).toPass({ timeout: 10000 });
    
    await expect(imagesequenceNode).toHaveClass(SELECTED, { timeout: 5000 });
    await page.waitForTimeout(500);
  
    // 2. Switch to the Explore tab
    const rightPanel = page.locator('#elephant-lab-right-panel');
    const exploreTab = rightPanel.getByRole('tab', { name: 'Explore', exact: true });
    await exploreTab.click();
  
    await expect(async () => {
      if (await exploreTab.getAttribute('aria-selected') !== 'true') {
        await exploreTab.click();
      }
    }).toPass({ timeout: 15000 });
  
    // 3. Wait for the plot container to appear
    const plotContainer = rightPanel.locator('div[data-plot], .plotly-graph-div, .js-plotly-plot, [data-component="plotly"]').first();
  
    await expect(plotContainer).toBeAttached({ timeout: 15000 });
    await expect(plotContainer).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(1000);
  
    // 4. Open the plot options
    const optionsButton = rightPanel.getByRole('button', { name: /Options/ });
    await optionsButton.click();
    await page.waitForTimeout(800);
  
    // 5. Change the colormap via the "Color Grade" dropdown
    const colorGradeRow = rightPanel.locator('.jp-rawplot-row', { hasText: 'Color Grade' });
    await colorGradeRow.locator('.jp-collapsible-select-button').click();
    const turboItem = colorGradeRow.locator('.jp-collapsible-select-item', { hasText: /^Turbo$/ });
    if (!(await turboItem.isVisible())) {
      await colorGradeRow.locator('summary', { hasText: 'Sequential' }).click();
    }
    await turboItem.click();
    await page.waitForTimeout(500);

    // Wait for it to disappear (update in progress)
    await expect(plotContainer).toBeHidden({ timeout: 5000 }).catch(() => {
    });
    
    // Wait for it to reappear (update complete)
    await expect(plotContainer).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(500); // Extra buffer
    
    // 6. Verify the plot is intact
    const box = await plotContainer.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.height).toBeGreaterThan(100);
    expect(box?.width).toBeGreaterThan(100);
    });

});