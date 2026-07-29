/* ---- analytics, split by risk ----

   GA4 runs for everyone. The Meta pixel and Clarity wait for a click.

   The split is not arbitrary. The exposure that matters in California is CIPA,
   not CPRA, and the two are not equally exposed under it. Session replay and
   the ad pixel are what the §631 wiretapping and §638.51 pen-register claims
   are actually aimed at: one records the visit, the other ships device and IP
   identifiers to a third party for cross-context advertising. First-party
   analytics with ads personalisation off is a much weaker target, and gating
   it costs real measurement for very little protection.

   Conversion reporting no longer depends on any of this. The Netlify function
   sends the Lead to Meta's Conversions API server-side on every submission, so
   ad optimisation sees 100% of real leads whatever the visitor clicks, and
   whatever their ad blocker does. The browser pixel is now a duplicate of that,
   deduplicated on event_id, not the primary signal.

   CPRA still requires the two choices be equally easy to take, so Accept and
   Decline are the same size, weight and colour, nothing is pre-ticked, and the
   decision is reversible from the footer. */
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

  /* ---- GA4: unconditional ---- */

  (function startGA4() {
    var g = document.createElement('script');
    g.async = true;
    g.src = 'https://www.googletagmanager.com/gtag/js?id=' + IDS.ga4;
    document.head.appendChild(g);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    /* Ads signals off. That is what keeps this defensible as first-party
       measurement rather than another cross-context advertising pipe, and it
       is the assumption the whole split above rests on. */
    window.gtag('config', IDS.ga4, {
      allow_google_signals: false,
      allow_ad_personalization_signals: false
    });
  })();

  /* Page events go through here. GA4 always takes them; nothing is queued,
     because nothing is waiting. */
  window.track = function (name, params) {
    if (window.gtag) window.gtag('event', name, params || {});
  };

  /* ---- Meta pixel + Clarity: consent-gated ---- */

  var adToolsStarted = false;

  function startAdTools() {
    if (adToolsStarted) return;
    adToolsStarted = true;

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

    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, 'clarity', 'script', IDS.clarity);

    fireBrowserLead();
  }

  /* ---- the conversion ----
     GA4 records it either way. The Meta browser Lead only fires with the ad
     tools, and always carries the event_id the form submitted, so the server's
     Conversions API copy and this one collapse into a single conversion in
     Meta's reporting instead of counting twice. */
  function fireConversion() {
    var p = location.pathname.replace(/\.html$/, '').replace(/\/$/, '');
    if (p !== '/thank-you') return;
    if (!sessionStorage.getItem('lead_eid')) return;
    if (window.gtag) window.gtag('event', 'generate_lead', { lead_stage: 'complete' });
    fireBrowserLead();
  }

  function fireBrowserLead() {
    var p = location.pathname.replace(/\.html$/, '').replace(/\/$/, '');
    if (p !== '/thank-you') return;
    var eid = sessionStorage.getItem('lead_eid');
    if (!eid || !window.fbq) return;
    window.fbq('track', 'Lead', {}, { eventID: eid });
    sessionStorage.removeItem('lead_eid');
  }

  /* Declining stops the ad tools and removes what they set. GA4's own
     identifiers stay, because GA4 keeps running and deleting them would only
     turn one visitor into a stream of new ones. */
  function clearAdCookies() {
    var names = ['_fbp', '_fbc', '_clck', '_clsk', '_gcl_au'];
    var host = location.hostname;
    var domains = ['', host, '.' + host];
    var parts = host.split('.');
    if (parts.length > 2) domains.push('.' + parts.slice(-2).join('.'));

    document.cookie.split(';').forEach(function (c) {
      var name = c.split('=')[0].trim();
      if (names.indexOf(name) === -1) return;
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
        '<p class="consent-copy">We use cookies to see how this site is doing, ' +
        'and to measure our ads. <a href="' + PRIVACY + '">Privacy</a></p>' +
        '<div class="consent-actions">' +
          '<button type="button" class="consent-btn consent-yes">Accept</button>' +
          '<button type="button" class="consent-btn consent-no">Decline</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);

    wrap.querySelector('.consent-yes').addEventListener('click', function () {
      write('granted'); wrap.remove(); startAdTools();
    });
    wrap.querySelector('.consent-no').addEventListener('click', function () {
      write('denied'); wrap.remove(); clearAdCookies();
    });
  }

  /* ---- boot ----

     /thank-you is shared by eleven pages and only all-done carries the banner
     so far. A visitor arriving from any of the others has never been asked, and
     those pages already fired the pixel on the landing page itself, so refusing
     to fire here would drop their conversion without protecting anything. On
     the confirmation page only, an absent choice keeps the previous behaviour.
     An explicit Decline is honoured everywhere. Rolling the banner out to the
     rest removes that branch. */
  var isConfirmation = /^\/thank-you(\.html)?\/?$/.test(location.pathname);
  var choice = read();

  if (choice === 'granted') {
    startAdTools();
  } else if (choice === 'denied') {
    clearAdCookies();
  } else if (isConfirmation) {
    startAdTools();
  } else {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', buildBanner);
    } else {
      buildBanner();
    }
  }

  fireConversion();

  /* Footer link, so the choice can be changed or withdrawn. This is also what
     the CPRA opt-out link points at. */
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-consent-open]');
    if (!t) return;
    e.preventDefault();
    buildBanner();
  });
})();
