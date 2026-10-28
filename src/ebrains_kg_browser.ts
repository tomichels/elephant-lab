import { Widget } from '@lumino/widgets';
import { Message } from '@lumino/messaging';

import { KernelBridge } from './kernel_bridge';
import { PythonCodeKey, getPythonCode } from './kernelcode';

// Results of elephant_lab/elephant_lab_ebrains.py
interface IEbrainsHit {
	id: string;
	title: string;
	accessibility: string | null;
	released: string | null;
	custodians: string[];
}

interface IEbrainsFile {
	name: string;
	path: string;
	url: string;
	format: string | null;
	size: string | null;
	neo_readable: boolean;
}

interface IEbrainsDataset {
	id: string;
	title: string;
	description: string;
	accessibility: string | null;
	doi: string | null;
	license: string | null;
	folder: string;
}

interface IEbrainsAuthStatus {
	installed?: boolean;
	logged_in?: boolean;
	user?: string | null;
	method?: string | null;
	error?: string;
}

// Files with load=false are companions that are only downloaded (e.g. Blackrock .ccf)
export interface IEbrainsSelection {
	dataset: IEbrainsDataset;
	files: { path: string; url: string; load: boolean }[];
}

// "search": KG search API without login, "fairgraph": KG Core API with EBRAINS login
type EbrainsBackend = 'search' | 'fairgraph';

const PAGE_SIZE = 20;
const FREE_ACCESS = 'free access';
const BACKEND_STORAGE_KEY = 'elephant-lab-ebrains-backend';
const SIZE_UNITS: { [unit: string]: number } = { BYTES: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

// Sizes come as text like "93 MB"; null if unknown
function parseSize(size: string | null): number | null {
	const match = size?.match(/^([\d.]+)\s*([a-z]+)$/i);
	const factor = match ? SIZE_UNITS[match[2].toUpperCase()] : undefined;
	return match && factor ? parseFloat(match[1]) * factor : null;
}

function formatSize(bytes: number): string {
	const unit = ['TB', 'GB', 'MB', 'KB'].find(u => bytes >= SIZE_UNITS[u]);
	return unit ? `${(bytes / SIZE_UNITS[unit]).toFixed(1)} ${unit}` : `${bytes} bytes`;
}

/**
 * Dialog body to search datasets of the EBRAINS Knowledge Graph and select files to load.
 * All requests run in the kernel (ElephantLab_ebrains), the widget only renders the results.
 */
export class EbrainsKgBrowser extends Widget {
	private kernelBridge: KernelBridge;
	private backend: EbrainsBackend;
	private auth: IEbrainsAuthStatus = {};
	private loginPollTimer: number | undefined;
	private searchInput: HTMLInputElement;
	private tokenInput: HTMLInputElement | null = null;
	private authBar: HTMLDivElement;
	private statusLine: HTMLDivElement;
	private resultsView: HTMLDivElement;
	private datasetView: HTMLDivElement;

	private query = '';
	private hits: IEbrainsHit[] = [];
	private total = 0;
	private cursor: string | null = null;

	private currentDataset: IEbrainsDataset | null = null;
	private files: IEbrainsFile[] = [];
	private selectedPaths = new Set<string>();
	// Files of the same recording as a selected file, and the ones of them the user unticked
	private companionPaths = new Set<string>();
	private excludedCompanions = new Set<string>();
	private onlyNeoReadable = true;
	private fileFilter = '';
	// Responses of superseded requests are ignored
	private requestCounter = 0;

	constructor(kernelBridge: KernelBridge) {
		super();
		this.kernelBridge = kernelBridge;
		this.addClass('jp-EbrainsKgBrowser');
		this.backend = localStorage.getItem(BACKEND_STORAGE_KEY) === 'fairgraph' ? 'fairgraph' : 'search';

		const backendSelect = document.createElement('select');
		backendSelect.className = 'jp-mod-styled jp-EbrainsKgBrowser-backend';
		backendSelect.title = 'The KG API needs an EBRAINS login and also lists the controlled access datasets you have access to';
		for (const [value, label] of [['search', 'Public search'], ['fairgraph', 'KG API (login)']]) {
			backendSelect.appendChild(new Option(label, value));
		}
		backendSelect.value = this.backend;
		backendSelect.onchange = () => void this.switchBackend(backendSelect.value as EbrainsBackend);

		this.searchInput = document.createElement('input');
		this.searchInput.className = 'jp-input';
		this.searchInput.placeholder = 'Search datasets, e.g. spike, hippocampus, macaque motor cortex';
		const searchButton = document.createElement('button');
		searchButton.className = 'jp-mod-styled jp-mod-accept';
		searchButton.innerHTML = '<i class="fa fa-search" aria-hidden="true"></i> Search';
		searchButton.onclick = () => void this.search();

		const searchRow = document.createElement('div');
		searchRow.className = 'jp-EbrainsKgBrowser-searchRow';
		searchRow.append(backendSelect, this.searchInput, searchButton);

		this.authBar = this.createElement('div', 'jp-EbrainsKgBrowser-auth');
		this.statusLine = this.createElement('div', 'jp-EbrainsKgBrowser-status');
		this.resultsView = this.createElement('div', 'jp-EbrainsKgBrowser-list');
		this.datasetView = this.createElement('div', 'jp-EbrainsKgBrowser-dataset');
		this.datasetView.hidden = true;
		this.node.append(searchRow, this.authBar, this.statusLine, this.resultsView, this.datasetView);
	}

	// Called by the Dialog on accept; null if no file is selected
	getValue(): IEbrainsSelection | null {
		if (!this.currentDataset || this.selectedPaths.size === 0) {
			return null;
		}
		const toLoad = this.files.filter(f => this.selectedPaths.has(f.path));
		return {
			dataset: this.currentDataset,
			files: [
				...toLoad.map(f => ({ path: f.path, url: f.url, load: true })),
				...this.downloadedCompanions().map(f => ({ path: f.path, url: f.url, load: false }))
			]
		};
	}

	protected onAfterAttach(msg: Message): void {
		super.onAfterAttach(msg);
		// The Dialog accepts on Enter in its capture phase, so Enter in the inputs has to be handled before
		document.addEventListener('keydown', this.onKeydown, true);
		// JupyterLab limits dialogs to 500px, too small for the file list
		this.node.closest('.jp-Dialog-content')?.classList.add('jp-EbrainsKgBrowser-dialog');
		this.searchInput.focus();
		void this.switchBackend(this.backend);
	}

	protected onBeforeDetach(msg: Message): void {
		document.removeEventListener('keydown', this.onKeydown, true);
		window.clearTimeout(this.loginPollTimer);
		super.onBeforeDetach(msg);
	}

	private onKeydown = (event: KeyboardEvent) => {
		if (event.key !== 'Enter' || (event.target !== this.searchInput && event.target !== this.tokenInput)) {
			return;
		}
		event.stopPropagation();
		event.preventDefault();
		if (event.target === this.searchInput) {
			void this.search();
		} else {
			void this.runAuth('login_with_token', this.tokenInput!.value);
		}
	};

	private createElement<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
		const element = document.createElement(tag);
		element.className = className;
		element.textContent = text;
		return element;
	}

	private createButton(label: string, onClick: () => void, accept = false): HTMLButtonElement {
		const button = this.createElement('button', `jp-mod-styled${accept ? ' jp-mod-accept' : ''}`, label);
		button.onclick = onClick;
		return button;
	}

	private async callKernel(key: PythonCodeKey, ...args: unknown[]): Promise<any> {
		// Login calls are not logged to the browser console, they can contain the access token
		const result = await this.kernelBridge.executeCode(
			getPythonCode(key, ...args), null, false, true, null, null, key !== PythonCodeKey.EbrainsAuth);
		if (!result?.resultKey) {
			return { error: 'No response from the kernel. Is Elephant Lab running in this notebook?' };
		}
		return JSON.parse(result.resultKey);
	}

	private setStatus(text: string, isError = false) {
		this.statusLine.textContent = text;
		this.statusLine.classList.toggle('jp-mod-error', isError);
	}

	private handleError(data: { error: string; auth_required?: boolean }) {
		this.setStatus(data.error, true);
		if (data.auth_required) {
			this.auth.logged_in = false;
			this.renderAuth();
		}
	}

	private async switchBackend(backend: EbrainsBackend) {
		this.backend = backend;
		localStorage.setItem(BACKEND_STORAGE_KEY, backend);
		this.authBar.hidden = backend !== 'fairgraph';
		if (backend === 'fairgraph') {
			await this.runAuth('status');
		} else {
			await this.search();
		}
	}

	// Runs a login action of ElephantLab_ebrains.auth, shows the resulting login status and searches again
	private async runAuth(action: string, ...args: unknown[]) {
		this.renderAuthMessage('Contacting EBRAINS…');
		this.auth = await this.callKernel(PythonCodeKey.EbrainsAuth, action, ...args);
		this.renderAuth(this.auth.error);
		await this.search();
	}

	private renderAuthMessage(text: string, isError = false, ...elements: HTMLElement[]) {
		const message = this.createElement('span', 'jp-EbrainsKgBrowser-authMessage', text);
		message.classList.toggle('jp-mod-error', isError);
		this.authBar.replaceChildren(message, ...elements);
	}

	// Login bar for the current login status; error is shown when logged out
	private renderAuth(error?: string) {
		this.tokenInput = null;
		const retry = this.createButton('Retry', () => void this.runAuth('status'));
		if (this.auth.installed === undefined) {
			this.renderAuthMessage(this.auth.error ?? 'Could not check the EBRAINS login.', true, retry);
		} else if (!this.auth.installed) {
			this.renderAuthMessage('The KG API needs fairgraph. Run %pip install fairgraph in the notebook, then retry.', false, retry);
		} else if (this.auth.logged_in) {
			const user = this.auth.user ? ` as ${this.auth.user}` : '';
			this.renderAuthMessage(`✓ Logged in to EBRAINS${user} (${this.auth.method})`, false,
				this.createButton('Log out', () => void this.runAuth('logout')));
		} else {
			this.renderAuthMessage(error ?? 'Log in with your EBRAINS account to use the KG API:', !!error,
				this.createButton('Log in with EBRAINS', () => void this.startLogin(), true),
				this.createButton('Use access token…', () => this.showTokenInput()));
		}
	}

	private showTokenInput() {
		const input = this.createElement('input', 'jp-input');
		input.type = 'password';
		input.placeholder = 'Paste an EBRAINS access token';
		input.autocomplete = 'off';
		this.authBar.replaceChildren(input,
			this.createButton('Use token', () => void this.runAuth('login_with_token', input.value), true),
			this.createButton('Cancel', () => this.renderAuth()));
		this.tokenInput = input;
		input.focus();
	}

	// OAuth device flow: the user confirms a code on the EBRAINS login page while the dialog polls the kernel
	private async startLogin() {
		// Opened before the await: a window opened later does not count as reaction to the click and is blocked
		const loginTab = window.open('', '_blank');
		this.renderAuthMessage('Starting EBRAINS login…');
		const login = await this.callKernel(PythonCodeKey.EbrainsAuth, 'start_login');
		if (!login.url) {
			loginTab?.close();
			this.renderAuth(login.error);
			return;
		}
		if (loginTab) {
			loginTab.location.href = login.url;
		}
		// Link in case the browser blocked the tab
		const link = this.createElement('a', '', 'open the EBRAINS login page');
		link.href = login.url;
		link.target = '_blank';
		link.rel = 'noopener';
		const message = this.createElement('span', 'jp-EbrainsKgBrowser-authMessage', `Log in and confirm the code ${login.user_code} (`);
		message.append(link, '). Waiting…');
		this.authBar.replaceChildren(message, this.createButton('Cancel', () => this.stopLogin()));

		const poll = async () => {
			const result = await this.callKernel(PythonCodeKey.EbrainsAuth, 'poll_login');
			if (this.loginPollTimer === undefined) {
				return;  // cancelled meanwhile
			}
			if (result.state === 'pending') {
				this.loginPollTimer = window.setTimeout(poll, login.interval * 1000);
				return;
			}
			this.loginPollTimer = undefined;
			if (result.state === 'done') {
				this.auth = result;
				this.renderAuth();
				await this.search();
			} else {
				this.renderAuth(`EBRAINS login failed: ${result.error}`);
			}
		};
		this.loginPollTimer = window.setTimeout(poll, login.interval * 1000);
	}

	private stopLogin() {
		window.clearTimeout(this.loginPollTimer);
		this.loginPollTimer = undefined;
		this.renderAuth();
	}

	private async search(loadMore = false) {
		const requestId = ++this.requestCounter;
		if (!loadMore) {
			this.query = this.searchInput.value.trim();
			this.hits = [];
			this.cursor = null;
		}
		this.showResultsView();
		if (this.backend === 'fairgraph' && !this.auth.logged_in) {
			this.resultsView.replaceChildren();
			this.setStatus('Log in to EBRAINS above, or switch to “Public search”.');
			return;
		}
		this.setStatus(loadMore ? 'Loading more…' : 'Searching the EBRAINS Knowledge Graph…');
		const data = await this.callKernel(PythonCodeKey.EbrainsSearch, this.query, PAGE_SIZE, this.cursor, this.backend);
		if (requestId !== this.requestCounter) {
			return;
		}
		if (data.error) {
			this.handleError(data);
			return;
		}
		this.hits.push(...data.hits);
		this.total = data.total;
		this.cursor = data.cursor;
		this.showSearchStatus();
		this.renderResults();
	}

	private showSearchStatus() {
		const query = this.query ? ` for “${this.query}”` : '';
		this.setStatus(this.total === 0 ? 'No datasets found.' : `${this.total} datasets${query}. Click one to see its files.`);
	}

	private showResultsView() {
		this.resultsView.hidden = false;
		this.datasetView.hidden = true;
	}

	private renderResults() {
		this.resultsView.replaceChildren();
		for (const hit of this.hits) {
			const item = this.createElement('div', 'jp-EbrainsKgBrowser-item');
			item.onclick = () => void this.openDataset(hit.id);
			const meta = this.createElement('div', 'jp-EbrainsKgBrowser-meta',
				[hit.custodians.join(', '), hit.released].filter(Boolean).join(' · '));
			if (hit.accessibility && hit.accessibility !== FREE_ACCESS) {
				meta.append(this.createElement('span', 'jp-EbrainsKgBrowser-badge', hit.accessibility));
			}
			item.append(this.createElement('div', 'jp-EbrainsKgBrowser-itemTitle', hit.title), meta);
			this.resultsView.appendChild(item);
		}
		if (this.cursor) {
			const more = this.createButton('Load more', () => void this.search(true));
			more.classList.add('jp-EbrainsKgBrowser-more');
			this.resultsView.appendChild(more);
		}
	}

	private async openDataset(datasetId: string) {
		const requestId = ++this.requestCounter;
		this.setStatus('Loading dataset files…');
		const data = await this.callKernel(PythonCodeKey.EbrainsListFiles, datasetId, this.backend);
		if (requestId !== this.requestCounter) {
			return;
		}
		if (data.error) {
			this.handleError(data);
			return;
		}
		this.currentDataset = data.dataset;
		this.files = data.files;
		this.selectedPaths.clear();
		this.excludedCompanions.clear();
		this.fileFilter = '';
		this.resultsView.hidden = true;
		this.datasetView.hidden = false;
		const readable = this.files.filter(f => f.neo_readable).length;
		this.setStatus(`${this.files.length} files, ${readable} readable by neo. Tick the files to load.`);
		this.renderDataset();
	}

	private renderDataset() {
		const dataset = this.currentDataset!;
		const back = this.createButton('', () => {
			this.requestCounter++;
			this.currentDataset = null;
			this.showResultsView();
			this.showSearchStatus();
		});
		back.classList.add('jp-EbrainsKgBrowser-back');
		back.innerHTML = '<i class="fa fa-arrow-left" aria-hidden="true"></i> Back to results';

		const meta = this.createElement('div', 'jp-EbrainsKgBrowser-meta');
		if (dataset.doi) {
			const doi = this.createElement('a', '', `DOI ${dataset.doi}`);
			doi.href = `https://doi.org/${dataset.doi}`;
			doi.target = '_blank';
			doi.rel = 'noopener';
			meta.append(doi);
		}
		if (dataset.license) {
			meta.append(`${dataset.doi ? ' · ' : ''}${dataset.license}`);
		}
		const restricted = dataset.accessibility && dataset.accessibility !== FREE_ACCESS;
		if (restricted) {
			meta.append(this.createElement('span', 'jp-EbrainsKgBrowser-badge', dataset.accessibility!));
		}

		const description = this.createElement('div', 'jp-EbrainsKgBrowser-description', dataset.description);
		description.title = 'Click to expand';
		description.onclick = () => description.classList.toggle('jp-mod-expanded');

		this.datasetView.replaceChildren(back, this.createElement('div', 'jp-EbrainsKgBrowser-datasetTitle', dataset.title), meta, description);
		if (this.files.length === 0) {
			this.datasetView.append(this.createElement('div', 'jp-EbrainsKgBrowser-note', restricted
				? `This dataset is not openly accessible (${dataset.accessibility}), its files are only listed with an EBRAINS login.`
				: 'This dataset has no files listed in the Knowledge Graph.'));
			return;
		}

		const fileList = this.createElement('div', 'jp-EbrainsKgBrowser-list jp-EbrainsKgBrowser-files');
		const filterInput = this.createElement('input', 'jp-input');
		filterInput.placeholder = 'Filter files by name';
		filterInput.oninput = () => {
			this.fileFilter = filterInput.value.trim().toLowerCase();
			this.renderFileList(fileList);
		};
		const toggleShown = this.createButton('', () => {
			const shown = this.visibleFiles();
			const allSelected = shown.every(f => this.selectedPaths.has(f.path));
			shown.forEach(f => allSelected ? this.selectedPaths.delete(f.path) : this.selectedPaths.add(f.path));
			this.renderFileList(fileList);
			this.updateSelection();
		});
		toggleShown.classList.add('jp-EbrainsKgBrowser-toggleShown');
		const onlyReadable = this.createElement('input', '');
		onlyReadable.type = 'checkbox';
		onlyReadable.checked = this.onlyNeoReadable;
		onlyReadable.onchange = () => {
			this.onlyNeoReadable = onlyReadable.checked;
			this.renderFileList(fileList);
		};
		const onlyReadableLabel = this.createElement('label', '');
		onlyReadableLabel.title = 'Based on the file extension';
		onlyReadableLabel.append(onlyReadable, ' Only files neo can read');
		const filterRow = this.createElement('div', 'jp-EbrainsKgBrowser-filterRow');
		filterRow.append(filterInput, toggleShown, onlyReadableLabel);

		this.datasetView.append(filterRow, fileList,
			this.createElement('div', 'jp-EbrainsKgBrowser-companions'),
			this.createElement('div', 'jp-EbrainsKgBrowser-summary'),
			this.createElement('div', 'jp-EbrainsKgBrowser-note',
				`Files are saved next to the notebook in ${dataset.folder}/ and not downloaded again if they exist.`));
		this.renderFileList(fileList);
		this.updateSelection();
	}

	private visibleFiles(): IEbrainsFile[] {
		return this.files.filter(f =>
			(!this.onlyNeoReadable || f.neo_readable) &&
			(!this.fileFilter || f.path.toLowerCase().includes(this.fileFilter)));
	}

	private downloadedCompanions(): IEbrainsFile[] {
		return this.files.filter(f => this.companionPaths.has(f.path) && !this.excludedCompanions.has(f.path));
	}

	private fileRow(file: IEbrainsFile, checked: boolean, onChange: (checked: boolean) => void): HTMLLabelElement {
		const checkbox = this.createElement('input', '');
		checkbox.type = 'checkbox';
		checkbox.checked = checked;
		checkbox.onchange = () => onChange(checkbox.checked);
		const name = this.createElement('span', 'jp-EbrainsKgBrowser-fileName', file.path);
		name.title = file.format ?? '';
		const row = this.createElement('label', 'jp-EbrainsKgBrowser-fileRow');
		row.append(checkbox, name, this.createElement('span', 'jp-EbrainsKgBrowser-size', file.size ?? ''));
		return row;
	}

	private renderFileList(fileList: HTMLDivElement) {
		const visible = this.visibleFiles();
		fileList.replaceChildren(...visible.map(file => this.fileRow(file, this.selectedPaths.has(file.path), checked => {
			checked ? this.selectedPaths.add(file.path) : this.selectedPaths.delete(file.path);
			this.updateSelection();
		})));
		if (visible.length === 0) {
			fileList.append(this.createElement('div', 'jp-EbrainsKgBrowser-note', 'No matching files.'));
		}
		this.updateToggleShownLabel();
	}

	private updateToggleShownLabel() {
		const shown = this.visibleFiles();
		const allSelected = shown.length > 0 && shown.every(f => this.selectedPaths.has(f.path));
		this.datasetView.querySelector('.jp-EbrainsKgBrowser-toggleShown')!.textContent =
			allSelected ? 'Deselect shown' : `Select all shown (${shown.length})`;
	}

	// Recomputes the companions and the summary after the selection changed
	private updateSelection() {
		// Companions: files in the same folder with the same name but another extension, e.g. Blackrock .nev + .nsX + .ccf
		const stem = (path: string) => path.replace(/\.[^./]+$/, '');
		const selectedStems = new Set([...this.selectedPaths].map(stem));
		const companions = this.files.filter(f => !this.selectedPaths.has(f.path) && selectedStems.has(stem(f.path)));
		this.companionPaths = new Set(companions.map(f => f.path));

		const section = this.datasetView.querySelector('.jp-EbrainsKgBrowser-companions')!;
		section.replaceChildren(...companions.map(file => this.fileRow(file, !this.excludedCompanions.has(file.path), checked => {
			checked ? this.excludedCompanions.delete(file.path) : this.excludedCompanions.add(file.path);
			this.updateSelection();
		})));
		if (companions.length > 0) {
			section.prepend(this.createElement('div', 'jp-EbrainsKgBrowser-meta', 'Also download files of the same recording (some formats need them):'));
		}
		this.updateToggleShownLabel();

		const count = this.selectedPaths.size;
		const downloaded = this.downloadedCompanions();
		const sizes = [...this.files.filter(f => this.selectedPaths.has(f.path)), ...downloaded].map(f => parseSize(f.size));
		const totalSize = formatSize(sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0));
		this.datasetView.querySelector('.jp-EbrainsKgBrowser-summary')!.textContent = count === 0
			? 'No files selected.'
			: `${count} file(s) to load` + (downloaded.length ? ` + ${downloaded.length} companion file(s)` : '')
			+ ` · ${sizes.includes(null) ? 'at least ' : ''}${totalSize} to download`;
	}
}
