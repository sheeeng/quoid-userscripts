import { openExtensionPage } from "../shared/utils.js";
import * as settingsStorage from "../shared/settings.js";
import { connectNative, sendNativeMessage } from "../shared/native.js";

// first sorts files by run-at value, then by weight value
function userscriptSort(a, b) {
	// map the run-at values to numeric values
	const runAtValues = {
		"document-start": 1,
		"document-end": 2,
		"document-idle": 3,
	};
	const runAtA = a.scriptObject["run-at"];
	const runAtB = b.scriptObject["run-at"];
	if (runAtA !== runAtB && runAtValues[runAtA] && runAtValues[runAtB]) {
		return runAtValues[runAtA] > runAtValues[runAtB];
	}
	return Number(a.scriptObject.weight) < Number(b.scriptObject.weight);
}

async function getPlatform() {
	let platform = localStorage.getItem("platform");
	if (!platform) {
		const message = { name: "REQ_PLATFORM" };
		const response = await sendNativeMessage(message);
		if (!response.platform) {
			console.error("Failed to get platform");
			return "";
		}
		platform = response.platform;
		localStorage.setItem("platform", platform);
	}
	return platform;
}

function setClipboard(data, type = "text/plain") {
	// future enhancement?
	// https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/write
	// https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText
	const onCopy = (e) => {
		e.stopImmediatePropagation();
		e.preventDefault();
		e.clipboardData.setData(type, data);
		document.removeEventListener("copy", onCopy, true);
	};

	const textarea = document.createElement("textarea");
	textarea.textContent = "<empty clipboard>";
	document.body.appendChild(textarea);
	textarea.select();
	document.addEventListener("copy", onCopy, true);
	try {
		return document.execCommand("copy");
	} catch (error) {
		console.warn("setClipboard failed", error);
		document.removeEventListener("copy", onCopy, true);
		return false;
	} finally {
		document.body.removeChild(textarea);
	}
}

async function setBadgeCount() {
	const clearBadge = () => {
		if (import.meta.env.SAFARI_VERSION < 16.4) {
			browser.browserAction.setBadgeText({ text: "" });
		} else {
			browser.browserAction.setBadgeText({ text: null });
		}
	};
	// @todo until better introduce in ios, only set badge on macOS
	const platform = await getPlatform();
	// set a text badge or an empty string in visionOS will cause the extension's icon to no longer be displayed
	// set it to null to fix already affected users
	if (platform === "visionos") {
		browser.browserAction.setBadgeText({ text: null });
		return;
	}
	if (platform !== "macos") return clearBadge();
	// @todo settingsStorage.get("global_exclude_match")
	const settings = await settingsStorage.get([
		"global_active",
		"toolbar_badge_count",
	]);
	if (settings.global_active === false) return clearBadge();
	if (settings.toolbar_badge_count === false) return clearBadge();

	const currentTab = await browser.tabs.getCurrent();
	// no active tabs exist (user closed all windows)
	if (!currentTab) return clearBadge();
	const url = currentTab.url;
	// if url doesn't exist, stop
	if (!url) return clearBadge();
	// only check for http/s pages
	if (!url.startsWith("http://") && !url.startsWith("https://"))
		return clearBadge();
	// @todo if url match in global exclude list, clear badge
	const frameUrls = new Set();
	const frames = await browser.webNavigation.getAllFrames({
		tabId: currentTab.id,
	});
	for (let i = 0; i < frames.length; i++) {
		const frameUrl = frames[i].url;
		if (frameUrl !== url && frameUrl.startsWith("http")) {
			frameUrls.add(frameUrl);
		}
	}
	const message = {
		name: "POPUP_BADGE_COUNT",
		url,
		frameUrls: Array.from(frameUrls),
	};
	const response = await sendNativeMessage(message);
	if (response?.error) return console.error(response.error);
	if (response?.count > 0) {
		browser.browserAction.setBadgeText({ text: response.count.toString() });
	} else {
		const _url = new URL(url);
		if (_url.pathname.endsWith(".user.js")) {
			browser.browserAction.setBadgeText({ text: "JS" });
		} else {
			clearBadge();
		}
	}
}

// on startup get declarativeNetRequests
// and set the requests for the session
// should also check and refresh when:
// 1. dnr item save event in the page occurs
// 2. dnr item toggle event in the page occurs
// 3. external editor changes script file content
async function setSessionRules() {
	// not supported below safari 15.4
	if (!browser.declarativeNetRequest.updateSessionRules) return;
	await clearAllSessionRules();
	const message = { name: "REQ_REQUESTS" };
	const response = await sendNativeMessage(message);
	if (response.error) {
		console.error(response.error);
		return;
	}
	// there are no rules to apply
	if (!response.length) return;
	// loop through response, parse the rules, push to array and log
	const rules = [];
	for (let i = 0; i < response.length; i++) {
		const rule = response[i];
		const code = JSON.parse(rule.code);
		// check if an array or single rule
		if (Array.isArray(code)) {
			code.forEach((r) => rules.push(r));
			console.info(`Setting session rule: ${rule.name} (${code.length})`);
		} else {
			rules.push(code);
			console.info(`Setting session rule: ${rule.name}`);
		}
	}
	// generate unique ids for all rules to ensure no repeats
	const ids = randomNumberSet(1000, rules.length);
	rules.map((rule, index) => (rule.id = ids[index]));
	try {
		await browser.declarativeNetRequest.updateSessionRules({ addRules: rules });
	} catch (error) {
		console.error(`Error setting session rules: ${error}`);
		return;
	}
	console.info(`Finished setting ${rules.length} session rules`);
}

async function clearAllSessionRules() {
	const rules = await browser.declarativeNetRequest.getSessionRules();
	if (!rules.length) return;
	console.info(`Clearing ${rules.length} session rules`);
	const ruleIds = rules.map((a) => a.id);
	await browser.declarativeNetRequest.updateSessionRules({
		removeRuleIds: ruleIds,
	});
}

function randomNumberSet(max, count) {
	// generates a set of random unique numbers
	// returns an array
	const numbers = new Set();
	while (numbers.size < count) {
		numbers.add(Math.floor(Math.random() * (max - 1 + 1)) + 1);
	}
	return [...numbers];
}

// the current update logic is similar to setSessionRules()
// this feature needs a more detailed redesign in the future
// https://github.com/quoid/userscripts/issues/453
async function getContextMenuItems() {
	// macos exclusive feature
	const platform = await getPlatform();
	if (platform !== "macos") return;
	// since it's not possible to get a list of currently active menu items
	// on update, all context-menu items are cleared, then re-added
	// this is done to ensure fresh code changes appear
	await browser.menus.removeAll();
	// get the context-menu scripts
	const message = { name: "REQ_CONTEXT_MENU_SCRIPTS" };
	const response = await sendNativeMessage(message);
	if (response.error) {
		console.error(response.error);
		return;
	}
	// add menus items
	const items = response.files?.menu || [];
	if (items.length) {
		console.info(`Setting ${items.length} context-menu userscripts`);
	}
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		// context-menu scripts require @match value
		// @include values are ignored
		if (!item.scriptObject.matches.length) continue;
		addContextMenuItem(item);
	}
}

async function addContextMenuItem(userscript) {
	// context-menu items persist for a session
	// to avoid duplication, when created, save the filename to session storage
	const savedItems = sessionStorage.getItem("menu");
	// if the session storage key doesn't exist use empty array
	const activeItems = savedItems ? JSON.parse(savedItems) : [];
	if (activeItems.indexOf(userscript.scriptObject.filename) !== -1) {
		// if already saved, remove it, to get fresh code changes
		await browser.menus.remove(userscript.scriptObject.filename);
	}
	// potential bug? https://developer.apple.com/forums/thread/685273
	// https://stackoverflow.com/q/68431201
	// parse through match values and change pathnames to deal with bug
	const patterns = userscript.scriptObject.matches;
	patterns.forEach((pattern, index) => {
		try {
			const url = new URL(pattern);
			let pathname = url.pathname;
			if (pathname.length > 1 && pathname.endsWith("/")) {
				pathname = pathname.slice(0, -1);
			}
			patterns[index] = `${url.protocol}//${url.hostname}${pathname}`;
		} catch (error) {
			// prevent breaking when non-url pattern present
		}
	});

	browser.menus.create(
		{
			contexts: ["all"],
			documentUrlPatterns: patterns,
			id: userscript.scriptObject.filename,
			title: userscript.scriptObject.name,
		},
		() => {
			// add event listener if needed
			if (!browser.menus.onClicked.hasListener(contextClick)) {
				browser.menus.onClicked.addListener(contextClick);
			}
			// save the context-menu item reference to sessionStorage
			const value = JSON.stringify([userscript.scriptObject.filename]);
			sessionStorage.setItem("menu", value);
		},
	);
}

async function contextClick(info, tab) {
	// when any created context-menu item is clicked, send message to tab
	// the content script for that tag will have the context-menu code
	// which will get send back in the response if/when found
	const message = { name: "CONTEXT_RUN", menuItemId: info.menuItemId };
	const response = await browser.tabs.sendMessage(tab.id, message);
	// if code is returned, execute on that tab
	if (!response.code) return;
	browser.tabs.executeScript(tab.id, { code: response.code });
}

async function nativeChecks() {
	const response = await sendNativeMessage({
		name: "NATIVE_CHECKS",
	});
	if (response.error) {
		settingsStorage.set({ error_native: response });
		return false;
	}
	settingsStorage.reset("error_native");
	return true;
}

/**
 * Handles messages sent with `browser.runtime.sendMessage`
 * Make sure not to return `undefined` or `rejection`, otherwise the reply may never be delivered
 * @see {@link https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onMessage#listener}
 * @type {Parameters<typeof browser.runtime.onMessage.addListener>[0]}
 * @returns {Promise<{status: "pending"|"fulfilled"|"rejected", result?: any}>}
 */
async function handleMessage(message, sender) {
	switch (message.name) {
		case "REQ_USERSCRIPTS": {
			// get the page url from the content script that sent request
			const url = sender.url;
			// use frameId to determine if request came from top level window
			// if @noframes true, and isTop false, swift layer won't return code
			const isTop = sender.frameId === 0;
			// send request to swift layer to provide code for page url
			const message = { name: "REQ_USERSCRIPTS", url, isTop };
			try {
				const response = await sendNativeMessage(message);
				if (import.meta.env.MODE === "development") {
					console.debug("REQ_USERSCRIPTS", message, response);
				}
				// if request failed, send error to content script for logging
				if (response.error) return response;
				// sort files
				response.files.js.sort(userscriptSort);
				response.files.css.sort((a, b) => Number(a.weight) < Number(b.weight));
				// return sorted files for injection
				return response;
			} catch (error) {
				console.error(error);
				// @ts-ignore -- ignore for now and will reconstruct this in the future.
				return { error: String(error) };
			}
		}
		case "API_CLOSE_TAB": {
			try {
				await browser.tabs.remove(message.tabId || sender.tab.id);
				return { status: "fulfilled" };
			} catch (error) {
				console.error(message, sender, error);
				return { status: "rejected", result: String(error) };
			}
		}
		case "API_OPEN_TAB": {
			try {
				const tab = await browser.tabs.create({
					active: message.active,
					index: sender.tab.index + 1,
					url: message.url,
				});
				return { status: "fulfilled", result: tab };
			} catch (error) {
				console.error(message, sender, error);
				return { status: "rejected", result: String(error) };
			}
		}
		case "API_ADD_STYLE": {
			try {
				await browser.tabs.insertCSS(sender.tab.id, {
					code: message.css,
					cssOrigin: "user",
				});
				return { status: "fulfilled" };
			} catch (error) {
				console.error(message, sender, error);
				return { status: "rejected", result: String(error) };
			}
		}
		case "API_GET_TAB": {
			if (typeof sender.tab === "undefined") {
				const error = "unable to deliver tab due to empty tab id";
				return { status: "rejected", result: error };
			}
			try {
				const tabData = sessionStorage.getItem(`tab-${sender.tab.id}`);
				// if tabData is null, can still parse it and return that
				const tabObj = JSON.parse(tabData);
				return { status: "fulfilled", result: tabObj };
			} catch (error) {
				console.error("failed to parse tab data for getTab", error);
				return { status: "rejected", result: String(error) };
			}
		}
		case "API_SAVE_TAB": {
			if (sender.tab != null && sender.tab.id) {
				const key = `tab-${sender.tab.id}`;
				sessionStorage.setItem(key, JSON.stringify(message.tabObj));
				return { status: "fulfilled" };
			} else {
				const error = "unable to save tab, empty tab id";
				return { status: "rejected", result: String(error) };
			}
		}
		case "API_SET_CLIPBOARD": {
			const result = setClipboard(message.clipboardData, message.type);
			return { status: "fulfilled", result };
		}
		case "API_XHR": {
			// initializing an xhr instance
			const xhr = new XMLHttpRequest();
			// establish a long-lived port connection to content script
			const port = browser.tabs.connect(sender.tab.id, {
				name: message.xhrPortName,
			});
			// receive messages from content script and process them
			port.onMessage.addListener((msg) => {
				if (msg.name === "ABORT") xhr.abort();
				if (msg.name === "DISCONNECT") port.disconnect();
			});
			// handle port disconnect and clean tasks
			port.onDisconnect.addListener((p) => {
				if (p?.error) {
					console.error(
						`port disconnected due to an error: ${p.error.message}`,
					);
				}
			});
			// parse details and set up for xhr instance
			const details = message.details;
			const method = details.method || "GET";
			const user = details.user || null;
			const password = details.password || null;
			let body = details.data || null;
			if (typeof body === "string" && details.binary) {
				const len = body.length;
				const arr = new Uint8Array(len);
				for (let i = 0; i < len; i++) {
					arr[i] = body.charCodeAt(i);
				}
				body = new Blob([arr], { type: "text/plain" });
			}

			// xhr instances automatically filter out unexpected user values
			xhr.timeout = details.timeout;
			xhr.responseType = details.responseType;
			// record parsed values for subsequent use
			const responseType = xhr.responseType;
			// avoid unexpected behavior of legacy defaults such as parsing XML
			if (responseType === "") xhr.responseType = "text";
			// transfer to content script via arraybuffer and then parse to blob
			if (responseType === "blob") xhr.responseType = "arraybuffer";
			// transfer to content script via text and then parse to document
			if (responseType === "document") xhr.responseType = "text";
			// add required listeners and send result back to the content script
			for (const e of message.events) {
				if (!details[e]) continue;
				xhr[e] = async (event) => {
					// can not send xhr through postMessage
					// construct new object to be sent as "response"
					const x = {
						contentType: undefined, // non-standard
						readyState: xhr.readyState,
						response: xhr.response,
						responseHeaders: xhr.getAllResponseHeaders(),
						responseType,
						responseURL: xhr.responseURL,
						status: xhr.status,
						statusText: xhr.statusText,
						timeout: xhr.timeout,
					};
					// get content-type when headers received
					if (xhr.readyState >= xhr.HEADERS_RECEIVED) {
						x.contentType = xhr.getResponseHeader("Content-Type");
					}
					// only process when xhr is complete and data exist
					if (xhr.readyState === xhr.DONE && xhr.response !== null) {
						// need to convert arraybuffer data to postMessage
						if (
							xhr.responseType === "arraybuffer" &&
							xhr.response instanceof ArrayBuffer
						) {
							const buffer = xhr.response;
							x.response = Array.from(new Uint8Array(buffer));
						}
					}
					port.postMessage({ name: e, event, response: x });
				};
			}
			// if onloadend not set in xhr details
			// onloadend event won't be passed to content script
			// if that happens port DISCONNECT message won't be posted
			// if details lacks onloadend attach listener
			if (!details.onloadend) {
				xhr.onloadend = (event) => {
					port.postMessage({ name: "onloadend", event });
				};
			}
			if (details.overrideMimeType) {
				xhr.overrideMimeType(details.overrideMimeType);
			}
			xhr.open(method, details.url, true, user, password);
			// must set headers after `xhr.open()`, but before `xhr.send()`
			if (typeof details.headers === "object") {
				for (const [key, val] of Object.entries(details.headers)) {
					xhr.setRequestHeader(key, val);
				}
			}
			xhr.send(body);
			return { status: "fulfilled" };
		}
		case "REFRESH_SESSION_RULES": {
			setSessionRules();
			break;
		}
		case "REFRESH_CONTEXT_MENU_SCRIPTS": {
			getContextMenuItems();
			break;
		}
	}
}
browser.runtime.onInstalled.addListener(async () => {
	nativeChecks();
});
browser.runtime.onStartup.addListener(async () => {
	setSessionRules();
	getContextMenuItems();
});
// listens for messages from content script, popup and page
browser.runtime.onMessage.addListener(handleMessage);
// set the badge count
browser.tabs.onActivated.addListener(setBadgeCount);
browser.windows.onFocusChanged.addListener(async (windowId) => {
	if (windowId < 1) {
		// lose focus
		return;
	}
	nativeChecks();
	setBadgeCount();
	setSessionRules();
	getContextMenuItems();
});
browser.webNavigation.onCompleted.addListener(setBadgeCount);

// handle native app messages
const port = connectNative();
port.onMessage.addListener((message) => {
	// console.info(message); // DEBUG
	if (message.name === "SAVE_LOCATION_CHANGED") {
		openExtensionPage();
		if (message?.userInfo?.returnApp === true) {
			sendNativeMessage({ name: "OPEN_APP" });
		}
	}
	// if (message.name === "OPEN_EXTENSION_PAGE") {
	// 	openExtensionPage();
	// }
});
