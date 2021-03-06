import 'fetch';
import * as Utils from './mod/utils';
import {domconsole} from './mod/domconsole';
import {config} from './config';
// storage stuff

export let Store = localforage.createInstance({
	name: 'especser',
	storeName: config.IDBstoreName
});

export let Data = {
	indexToId: {}, // 4.6.5: #sec-foo
	idToIndex: {}, // #sec-foo: 4.6.5...
	indexToFrameIndex: {}, // eg: 2.1.3 maps to 17 where 17 is the index of the corresponding frame inside stack
	stack: [] // contains frames containing data
};

export function indexToPath (index) {
	let pathNums = index.split('.');
	return pathNums.map((_, i, arr) => arr.slice(0, i + 1).join('.')).map(
		num => Data.stack[Data.indexToFrameIndex[num]].title
	).join(' | ');
}

export function indexToFrame (index) {
	try {
		return Data.stack[Data.indexToFrameIndex[index]];
	} catch (err) { return null; }
}

// functions to scrape spec

function fetchSpec (url = config.SPEC_URL) {
	console.log('sending request to %s', url);
	let f = fetch(
		url
	).then(res => res.text())
	.then(html => new DOMParser().parseFromString(html, 'text/html'));
	return f;
}

// replaces multiple simultaneous whitespace characters with single space
function normalize (string) {
	return string.replace(/(?:\n+|\s+)/g, ' ');
}

// *internal* takes list element, secnum (whatever) and extracts a title value
function extractText (el, secnum) {
	let c = $.cl('toc', el);
	let title = '';
	let nextEl = secnum.nextSibling;
	while (nextEl && nextEl.nodeName.toLowerCase() !== 'ol') {
		title += nextEl.textContent;
		nextEl = nextEl.nextSibling;
	}
	return normalize(title.trim());
}

function parseIndex (doc) {
	let elements = $$('span.secnum[id^="sec-"]', doc);

	elements.forEach(function (secnum, stackIndex) {

		let index = secnum.textContent;
		let isAnnex = false;
		if (index.startsWith('Annex')) {
			index = index.replace('Annex', '').trim();
			isAnnex = true;
		}

		let path = index.split('.');
		path = path.reduce(function (path, place) {
			let curr = path[path.length - 1];
			path.push(curr + '.' + place);
			return path;
		}, [path.shift()]);

		let id = secnum.firstChild.getAttribute('href').replace('#', '');

		let title = secnum.parentNode.textContent;

		if (isAnnex) {
			title = title.replace('Annex ' + index, '').trim();
		}
		else {
			title = title.replace(index, '').trim();
		}

		let children = [];
		let def = {index, id, title, children, path, stackIndex};
		Data.stack.push(def);

		Data.indexToId[index] = id;
		Data.idToIndex[id] = index;
		Data.indexToFrameIndex[index] = stackIndex;

		let parent = path[path.length - 2];
		if (parent) {
			Data.stack[Data.indexToFrameIndex[parent]].children.push(index);
		}

	});

	return doc;

}

function processStack (doc) {
	console.log('starting stack processing of %s frames', Data.stack.length);
	return Promise.all(Data.stack.map( // we have to defer this because if #8.5 refers to #9.5, the index will not be found
		frame => Store.setItem(frame.index, extractMaterial(frame.id, doc))
	)).then(
		_ => Store.setItem('appdata', Data)
	);
}

// *internal* conditionally assigns data-index attribute to element and returns modified element
function assignIndex (el) {
	let id = el.getAttribute('href');
	if (!id || !id.startsWith('#')) return el;
	let index = Data.idToIndex[id.replace('#', '')];
	if (!index) return el;
	el.setAttribute('href', '#' + index);
	el.dataset.index = index;
	el.classList.add('link-newtab');
	return el;
}

function extractMaterial (hash, content) {
	let c = $.id(hash.replace('#', ''), content);
	let f = $.cl('front', c);
	let container = f || c;
	let clone = container.cloneNode(true);
	$$.attr('id', undefined, clone).forEach(el => {el.removeAttribute('id');});
	$$.attr('href^=', '#', clone).forEach(assignIndex);
	return clone.innerHTML;
}

export function update () {
	console.log('update started');
	domconsole.log('fetching latest version of spec and caching locally. this might take a while.')
	return fetchSpec().then(parseIndex).then(processStack).then(
		_ => window.localStorage.setItem('lastIndexed', Date.now())
	).then(
		_ => {
			console.log('stack processed and saved in indexeddb. marked lastindex in localstorage');
			domconsole.log('caching and parsing completed! you can search for stuff and browse the spec now! :) (double click here to hide me)');
			$.id('console').addEventListener('dblclick', function removeMe () {
				this.classList.add('hidden');
				this.removeEventListener('dblclick', removeMe);
			}, false);
			window.dispatchEvent(new Event('hashchange'));
		}
	);
}

export function initialize () {
	console.log('initializing especser. we have ignition!');
	if (window.localStorage.getItem('lastIndexed')) {
		return Store.getItem('appdata').then(val => {
			Data = val;
			console.log('retrieved appdata from indexeddb from %s', localStorage.getItem('lastIndexed'));
		});
	}
	console.log('this session is brand new. starting update threads!');
	return update();
}

export function clear () {
	console.log('I have got orders from high command to evacuate all data from the ship.');
	domconsole.log('clearing store. this might take some time.');
	Data = {
		indexToId: {},
		idToIndex: {},
		indexToFrameIndex: {},
		stack: []
	};
	Store.clear().then(_ => localStorage.removeItem('lastIndexed')).then(
		_ => domconsole.log('store was emptied. click update to cache spec again.')
	);
}

// spec usage API to be exposed

const MAX_RESULTS = 8;

// *internal* query to be found in name
function fuzzySearch (name, query, max = MAX_RESULTS) {
	let pos = -1;
	for (let i = 0, len = query.length; i < len; i++) {
		let char = query[i];
		if (!char.trim()) continue; // removing whitespace
		pos = name.indexOf(char, pos+1);
		if (pos === -1) return false;
	}
	return true;
}

const RE_SEC = /^sec:\s*(?:(?:\d+\.?)+,?\s*)+\b/i;

/*

^ # start of string											|||||
sec: # "sec:"												|||||
\s* # forgive whitespace									|||||
(?: # begin matching set of indices					|||||		|||||
	(?: # begin matching individaul indices		|||||	|||||		|||||
		\d+ # one or more digits				|||||	|||||		|||||
		\.? # followed by a period				|||||	|||||		|||||
	)+ # and done								|||||	|||||		|||||
	,? # and maybe commas							|||||		|||||
	\s* # and maybe whitespace						|||||		|||||
)+ # 1 or more times								|||||		|||||
\b # and word boundary so trailing commas aren't matched	|||||

*/

function* executeSearch (stack, query, max = MAX_RESULTS) {

	query = (query + '').trim().toLowerCase();
	if (!query) return [];

	let index = query.match(RE_SEC), selectedStack = [];

	if (index && index[0]) {
		let indices = index[0].replace('sec:', '').trim().split(/,\s*/);

		// initializing selectedStack with parent indices and all there children
		// our stack is pretty large. so not using closures here
		for (let i = 0; i < indices.length; i++) {
			let frame = indexToFrame(indices[i]);
			if (!frame) continue;
			indices.push(...frame.children);
			selectedStack.push(frame);
		}
		query = query.replace(RE_SEC, '').replace(/[.,]/g, '').trim();
		if (!query) return selectedStack; // we return it here itself because the stack will likely not be large
	} else {
		selectedStack = stack;
	}

	for (
		let i = 0, len = selectedStack.length,
		results = [], fuzzyResults = [];
		i < len;
		i++
	) {
		let title = selectedStack[i].title.toLowerCase();
		if (title.indexOf(query) >= 0) {
			results.push(selectedStack[i]);
		}
		else if (fuzzySearch(title, query)) {
			fuzzyResults.push(selectedStack[i]);
		}
		if (results.length >= max) {
			yield results;
			results = [];
			continue;
		}
		else if (i >= len - 1) {
			results.push(...fuzzyResults.slice(0, (max - results.length) - 1));
			yield results;
			results = [];
			continue;
		}
	}
	return [];

}

export function search (query) {
	return executeSearch(Data.stack, query);
};
