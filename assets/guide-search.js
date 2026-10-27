// Live search for a user guide (any guide using _layouts/guide.html).
//
// The index (search.json next to the guide pages) holds each page's HTML. On
// first use it's split into one entry per heading, so a result links straight
// to the section it was found in. Results replace the sidebar contents while
// there's a query. Following a result highlights the search words on the page.
(function () {
	var form = document.querySelector('.guide-search');
	if (!form) return;
	var input = form.querySelector('input');
	var list = form.querySelector('.guide-search-results');
	var status = form.querySelector('.guide-search-status');
	var sidebar = form.closest('.sidebar');

	var MAX_RESULTS = 15;
	var sections = null, loading = null, results = [], active = -1;

	function norm(s) {
		return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[‘’]/g, "'");
	}
	// Drop common word endings so "acknowledge" also finds "acknowledging" and
	// "tasks" finds "tasking". Short words are left alone.
	function stem(t) {
		var s = t.replace(/(ing|ed|es|e|s)$/, '');
		return s.length >= 4 ? s : t;
	}
	function terms(q) {
		return norm(q).split(/\s+/).filter(Boolean).map(stem);
	}
	// Matches a search word through to the end of the word it's found in.
	function termsRe(ts) {
		return new RegExp(ts.map(reEscape).sort(function (a, b) { return b.length - a.length; }).map(function (t) { return t + "[a-z0-9']*"; }).join('|'), 'gi');
	}
	function esc(s) {
		return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
	}
	function reEscape(s) {
		return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	// Split each page into sections at h1–h4. Each section keeps the trail of
	// headings above it, e.g. Configuration › Map Markers › Capability Codes.
	function buildSections(pages) {
		var out = [];
		var parser = new DOMParser();
		pages.forEach(function (page) {
			var doc = parser.parseFromString('<body>' + page.html + '</body>', 'text/html');
			var trail = [], cur = null;
			function start(level, heading) {
				cur = { page: page.title, url: page.url, id: heading ? heading.id : '', level: level, title: heading ? heading.textContent.trim() : page.title, trail: trail.slice(0, level - 1).filter(Boolean), parts: [] };
				out.push(cur);
			}
			start(1, null);
			Array.prototype.forEach.call(doc.body.children, function (el) {
				var m = /^H([1-4])$/.exec(el.tagName);
				if (m) {
					var level = +m[1];
					trail.length = level;
					trail[level - 1] = el.textContent.trim();
					if (level === 1) { cur.title = trail[0]; cur.trail = []; return; }
					start(level, el);
					return;
				}
				// Image alt text describes what's in the screenshot, so it's searchable too.
				el.querySelectorAll('img[alt]').forEach(function (img) { img.replaceWith(' ' + img.alt + ' '); });
				cur.parts.push(el.textContent);
			});
		});
		out.forEach(function (s) {
			s.text = s.parts.join(' ').replace(/\s+/g, ' ').trim();
			s.nText = norm(s.text);
			s.nTitle = norm(s.title);
			s.nTrail = norm(s.trail.concat(s.page).join(' '));
			delete s.parts;
		});
		return out.filter(function (s) { return s.text || s.level > 1; });
	}

	function load() {
		if (!loading) {
			loading = fetch(form.dataset.index)
				.then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
				.then(function (pages) { sections = buildSections(pages); })
				.catch(function () { loading = null; status.textContent = "Search couldn't load. Check your connection and try again."; });
		}
		return loading;
	}

	function count(hay, needle) {
		var n = 0, i = hay.indexOf(needle);
		while (i !== -1 && n < 5) { n++; i = hay.indexOf(needle, i + needle.length); }
		return n;
	}
	function wordStart(hay, needle) {
		return new RegExp('(^|[^a-z0-9])' + reEscape(needle)).test(hay);
	}

	// Every word has to appear somewhere in the section, its headings or its
	// page title. Matches in headings count for more than matches in the text.
	function search(q) {
		var ts = terms(q);
		if (!ts.length) return [];
		var phrase = norm(q.trim());
		var found = [];
		sections.forEach(function (s) {
			var score = 0;
			for (var i = 0; i < ts.length; i++) {
				var t = ts[i];
				var inTitle = s.nTitle.indexOf(t) !== -1;
				var inText = s.nText.indexOf(t) !== -1;
				var inTrail = s.nTrail.indexOf(t) !== -1;
				if (!inTitle && !inText && !inTrail) return;
				if (inTitle) score += wordStart(s.nTitle, t) ? 20 : 6;
				if (inTrail) score += 2;
				if (inText) score += Math.min(count(s.nText, t), 5) + (wordStart(s.nText, t) ? 1 : 0);
			}
			if (ts.length > 1) {
				if (s.nTitle.indexOf(phrase) !== -1) score += 15;
				else if (s.nText.indexOf(phrase) !== -1) score += 6;
			}
			found.push({ s: s, score: score });
		});
		found.sort(function (a, b) { return b.score - a.score; });
		return found.slice(0, MAX_RESULTS).map(function (f) { return f.s; });
	}

	// Wrap each search word in <mark>. Works on the original text, so accents
	// and case are kept, matching on its normalised copy.
	function highlight(text, ts) {
		var re = termsRe(ts);
		var out = '', last = 0, m;
		var plain = norm(text);
		if (plain.length !== text.length) return esc(text); // normalising changed the length; skip marks rather than misplace them
		while ((m = re.exec(plain))) {
			if (!m[0]) { re.lastIndex++; continue; }
			out += esc(text.slice(last, m.index)) + '<mark>' + esc(text.slice(m.index, m.index + m[0].length)) + '</mark>';
			last = m.index + m[0].length;
		}
		return out + esc(text.slice(last));
	}
	function snippet(s, ts) {
		var text = s.text;
		if (!text) return '';
		var at = -1;
		for (var i = 0; i < ts.length && at === -1; i++) at = s.nText.indexOf(ts[i]);
		var from = Math.max(0, at - 50);
		if (from > 0) { var sp = text.indexOf(' ', from); if (sp !== -1 && sp < at) from = sp + 1; }
		var to = Math.min(text.length, from + 160);
		if (to < text.length) { var sp2 = text.lastIndexOf(' ', to); if (sp2 > from) to = sp2; }
		return (from > 0 ? '… ' : '') + highlight(text.slice(from, to), ts) + (to < text.length ? ' …' : '');
	}

	function href(s, q) {
		return s.url + '?q=' + encodeURIComponent(q.trim()) + (s.id ? '#' + s.id : '');
	}

	function render() {
		var q = input.value;
		var ts = terms(q);
		sidebar.classList.toggle('searching', ts.length > 0);
		input.setAttribute('aria-expanded', ts.length > 0 ? 'true' : 'false');
		active = -1;
		input.removeAttribute('aria-activedescendant');
		if (!ts.length) { list.innerHTML = ''; status.textContent = ''; return; }
		if (!sections) { status.textContent = 'Loading…'; load().then(function () { if (sections && input.value === q) render(); }); return; }
		results = search(q);
		status.textContent = results.length ? (results.length === MAX_RESULTS ? 'Top ' + MAX_RESULTS + ' results' : results.length + (results.length === 1 ? ' result' : ' results')) : 'No results for “' + q.trim() + '”';
		list.innerHTML = results.map(function (s, i) {
			var where = s.level > 1 ? [s.page].concat(s.trail.slice(1)).join(' › ') : 'Page';
			return '<li role="option" id="guide-search-' + i + '" aria-selected="false"><a href="' + esc(href(s, q)) + '" tabindex="-1">'
				+ '<span class="r-where">' + esc(where) + '</span>'
				+ '<span class="r-title">' + highlight(s.title, ts) + '</span>'
				+ (s.text ? '<span class="r-text">' + snippet(s, ts) + '</span>' : '')
				+ '</a></li>';
		}).join('');
	}

	function setActive(i) {
		var items = list.children;
		if (!items.length) return;
		if (active >= 0 && items[active]) items[active].setAttribute('aria-selected', 'false');
		active = (i + items.length) % items.length;
		items[active].setAttribute('aria-selected', 'true');
		items[active].scrollIntoView({ block: 'nearest' });
		input.setAttribute('aria-activedescendant', items[active].id);
	}

	var timer;
	input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(render, 80); });
	input.addEventListener('focus', load, { once: true });
	input.addEventListener('keydown', function (e) {
		if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
		else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
		else if (e.key === 'Escape') {
			if (input.value) { input.value = ''; render(); } else input.blur();
		}
	});
	form.addEventListener('submit', function (e) {
		e.preventDefault();
		clearTimeout(timer);
		if (!sections) return;
		render();
		var a = list.querySelectorAll('a')[active >= 0 ? active : 0];
		if (a) location.href = a.href;
	});
	// The clear (×) button on a search field fires "search" with an empty value.
	input.addEventListener('search', function () { if (!input.value) render(); });

	// "/" jumps to the search box from anywhere on the page.
	document.addEventListener('keydown', function (e) {
		if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
		var t = e.target;
		if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
		e.preventDefault();
		input.focus();
		input.select();
	});

	// Arrived from a search result: highlight the words on the page, then tidy
	// ?q= out of the address bar so the link people copy is the plain one.
	var params = new URLSearchParams(location.search);
	var q = params.get('q');
	if (q) {
		input.value = q;
		var ts = terms(q);
		var prose = document.querySelector('article .prose');
		if (prose && ts.length) markPage(prose, ts);
		params.delete('q');
		var rest = params.toString();
		history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
	}

	// A link to a section that has since moved to another page (e.g. an old
	// What's New link or a bookmark) lands here with a #hash that isn't on this
	// page. Find the section's new page in the index and go there.
	var hash = decodeURIComponent(location.hash.slice(1));
	if (hash && !document.getElementById(hash)) {
		load().then(function () {
			var moved = sections && sections.filter(function (s) { return s.id === hash && s.url !== location.pathname; })[0];
			if (moved) location.replace(moved.url + location.search + '#' + hash);
		});
	}

	function markPage(root, ts) {
		var re = termsRe(ts);
		var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode: function (n) {
				return n.nodeValue.trim() && !n.parentNode.closest('code, pre, mark, script, style') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
			}
		});
		var nodes = [];
		while (walker.nextNode()) nodes.push(walker.currentNode);
		nodes.forEach(function (n) {
			var text = n.nodeValue, plain = norm(text);
			if (plain.length !== text.length) return;
			re.lastIndex = 0;
			if (!re.test(plain)) return;
			re.lastIndex = 0;
			var frag = document.createDocumentFragment(), last = 0, m;
			while ((m = re.exec(plain))) {
				if (!m[0]) { re.lastIndex++; continue; }
				frag.appendChild(document.createTextNode(text.slice(last, m.index)));
				var mark = document.createElement('mark');
				mark.className = 'search-hit';
				mark.textContent = text.slice(m.index, m.index + m[0].length);
				frag.appendChild(mark);
				last = m.index + m[0].length;
			}
			frag.appendChild(document.createTextNode(text.slice(last)));
			n.parentNode.replaceChild(frag, n);
		});
	}
})();
