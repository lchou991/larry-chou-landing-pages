/* ---- consent-gated analytics ----
   GA4, the Meta pixel and Clarity, none of which run until the visitor has
   said yes. Ported from larrychou.com so both properties behave the same way.

   Why opt-in rather than the usual load-first-ask-later banner: the exposure
   here is not really CPRA, it is CIPA. California's wiretapping statute is
   being used against small businesses over exactly this stack, and the claim
   is that a pixel or a session recorder intercepts communications without
   consent. Prior express consent is the defence, and it only works if nothing
   fires before the click. So the trackers are inert until then, and declining
   leaves the page with no third-party scripts at all.

   That matters more here than on the main site: these are paid-traffic pages,
   and Clarity records a session replay of everything the visitor does on them.

   CPRA also requires the two choices be equally easy to take, so Accept and
   Decline are the same size, same weight, same prominence. No pre-ticked
   anything, and the decision is reversible from the footer link on the page.

   Privacy lives on the main site; this subdomain has no page of its own, so
   the link is absolute. */
(function () {
  'use strict';

  var KEY = 'chou-consent-v1';
  var IDS = {
    ga4:     'G-5RX0R77WHE',
    meta:    '1533514048115355',
    clarity: 'wmjl25izee'
  };
  var PRIVACY = 'https://larrychou.com/privacy';

  function read()  { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function write(v){ try { localStorage.setItem(KEY, v); } catch (e) { /* private mode */ } }

  /* ---- the trackers themselves ---- */

  var started = false;

  function startTracking() {
    if (started) return;
    started = true;

    /* GA4 */
    var g = document.createElement('script');
    g.async = true;
    g.src = 'https://www.googletagmanager.com/gtag/js?id=' + IDS.ga4;
    document.head.appendChild(g);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', IDS.ga4);

    /* Meta pixel */
    (function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n;
      n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
      t = b.createElement(e); t.async = true; t.src = v;
      s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', IDS.meta);
    window.fbq('track', 'PageView');

    /* Microsoft Clarity */
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, 'clarity', 'script', IDS.clarity);

    /* Anything the page queued before the visitor accepted now gets sent, so a
       consent click does not cost the events that led up to it. */
    flushPending();
    fireFunnelEvent();
  }

  /* ---- event queue ----
     The page fires form_start and address_captured through window.track(). If
     consent has not been given yet those are held, not dropped: someone who
     fills the form and only then accepts still reports the whole funnel. If
     they decline, the queue is discarded and nothing is ever sent. */
  var pending = [];

  window.track = function (name, params) {
    if (started && window.gtag) { window.gtag('event', name, params || {}); return; }
    if (read() === 'denied') return;
    pending.push([name, params || {}]);
  };

  function flushPending() {
    while (pending.length) {
      var e = pending.shift();
      if (window.gtag) window.gtag('event', e[0], e[1]);
    }
  }

  /* ---- funnel events ----
     /thank-you means the full form posted. The Meta standard Lead fires only
     there, and only when the page that submitted set lead_eid, so a refresh or
     a direct visit cannot inflate it. */
  function fireFunnelEvent() {
    var p = location.pathname.replace(/\.html$/, '').replace(/\/$/, '');
    if (p === '/thank-you') {
      if (sessionStorage.getItem('lead_eid')) {
        if (window.fbq)  window.fbq('track', 'Lead');
        if (window.gtag) window.gtag('event', 'generate_lead', { lead_stage: 'complete' });
        sessionStorage.removeItem('lead_eid');
      }
    }
  }

  /* Withdrawing consent has to actually undo something. Blocking the scripts
     stops new collection, but anything already accepted leaves its cookies
     behind, and the policy says declining stops collection. So the identifiers
     these three set get deleted too. Cleared on both the host and the dotted
     parent, since that is how they were written. */
  function clearTrackingCookies() {
    var names = ['_ga', '_gid', '_gcl_au', '_fbp', '_fbc', '_clck', '_clsk'];
    var host = location.hostname;
    var domains = ['', host, '.' + host];
    var parts = host.split('.');
    if (parts.length > 2) domains.push('.' + parts.slice(-2).join('.'));

    document.cookie.split(';').forEach(function (c) {
      var name = c.split('=')[0].trim();
      var match = names.indexOf(name) > -1 || name.indexOf('_ga_') === 0;
      if (!match) return;
      domains.forEach(function (d) {
        document.cookie = name + '=; Max-Age=0; path=/' + (d ? '; domain=' + d : '');
      });
    });
  }

  /* ---- the banner ---- */

  function buildBanner() {
    if (document.querySelector('.consent')) return;
    var wrap = document.createElement('div');
    wrap.className = 'consent';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', 'Cookie choices');
    wrap.innerHTML =
      '<div class="consent-inner">' +
        '<p class="consent-copy">We use cookies to see how this site is doing. ' +
        '<a href="' + PRIVACY + '">Privacy</a></p>' +
        '<div class="consent-actions">' +
          '<button type="button" class="consent-btn consent-yes">Accept</button>' +
          '<button type="button" class="consent-btn consent-no">Decline</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);

    wrap.querySelector('.consent-yes').addEventListener('click', function () {
      write('granted'); wrap.remove(); startTracking();
    });
    wrap.querySelector('.consent-no').addEventListener('click', function () {
      write('denied'); wrap.remove(); pending.length = 0; clearTrackingCookies();
    });
  }

  /* ---- boot ----

     /thank-you is shared. Eleven pages post to it and only all-done carries the
     banner so far, so a visitor arriving from any of the others has never been
     asked and has nothing stored. Treating that as "no consent" would silently
     stop reporting their conversion to Meta, which is a reporting regression
     dressed up as a privacy win: those pages already fired the pixel on the
     landing page itself, so nothing is protected by refusing to fire here.

     So on the confirmation page only, an absent choice means "came from a page
     that was never gated" and tracking behaves as it did before. An explicit
     Decline is still honoured everywhere. No banner is shown here either: it is
     the wrong moment to interrupt, and the landing page is where the ask
     belongs. Rolling the banner out to the other ten pages is what removes this
     branch. */
  var isConfirmation = /^\/thank-you(\.html)?\/?$/.test(location.pathname);
  var choice = read();

  if (choice === 'granted') {
    startTracking();
  } else if (choice === 'denied') {
    /* Nothing loads. Cookies are also swept on every page, not just at the
       moment Decline is clicked: identifiers set before the visitor declined,
       or by a page that has no banner yet, would otherwise sit there for two
       years on a browser that has asked not to be tracked. */
    clearTrackingCookies();
  } else if (isConfirmation) {
    startTracking();
  } else {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', buildBanner);
    } else {
      buildBanner();
    }
  }

  /* Footer link, so the choice can be changed or withdrawn. This is also what
     the CPRA opt-out link points at. */
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-consent-open]');
    if (!t) return;
    e.preventDefault();
    buildBanner();
  });
})();
