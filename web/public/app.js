/* MasterTime — helpers partagés du portail */
const MT = (() => {
  async function api(path, opts) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    return data;
  }

  const hm = (m) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  const DAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
  const fmtDay = (iso) => {
    const d = new Date(`${iso}T00:00:00`);
    return `${DAYS[(d.getDay() + 6) % 7]} ${d.getDate()}/${d.getMonth() + 1}`;
  };
  const AR_DAYS = ['الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد'];
  const fmtDayAr = (iso) => {
    const d = new Date(`${iso}T00:00:00`);
    return `${AR_DAYS[(d.getDay() + 6) % 7]} ${d.getDate()}/${d.getMonth() + 1}`;
  };
  const arRoom = (n) => String(n || '')
    .replace(/^Salle\s*/, 'القاعة ')
    .replace(/^Amphi\s*/, 'المدرج ')
    .replace(/^Annexe\s*/, 'الملحقة ');

  const pad = (n) => String(n).padStart(2, '0');
  const toIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function mondayOf(iso) {
    const d = new Date(`${iso}T00:00:00`);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return toIso(d);
  }
  function addDays(iso, n) {
    const d = new Date(`${iso}T00:00:00`);
    d.setDate(d.getDate() + n);
    return toIso(d);
  }
  const today = () => toIso(new Date());

  // Présence en ligne (compteur côté admin) — heartbeat 30 s.
  function heartbeat() {
    let v = localStorage.getItem('mt_visitor');
    if (!v) {
      v = crypto.randomUUID();
      localStorage.setItem('mt_visitor', v);
    }
    const ping = () =>
      api('/api/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ visitor: v }),
      })
        .then((d) => {
          const el = document.querySelector('[data-online]');
          if (el && d.online != null) el.textContent = d.online;
        })
        .catch(() => {});
    ping();
    setInterval(ping, 30000);
  }

  function header(active) {
    return `
      <img src="/assets/logo.png" alt="FSJP Tanger" onerror="this.style.display='none'">
      <div class="titles">
        <h1>Emplois du temps — Masters</h1>
        <p>Faculté des Sciences Juridiques et Politiques — Tanger</p>
      </div>
      <nav>
        <a href="/" ${active === 'home' ? 'style="background:rgba(255,255,255,.3)"' : ''}>الرئيسية</a>
        <a href="/edt.html" ${active === 'edt' ? 'style="background:rgba(255,255,255,.3)"' : ''}>جدول الحصص</a>
        <a href="/prof.html" ${active === 'prof' ? 'style="background:rgba(255,255,255,.3)"' : ''}>فضاء الأستاذ</a>
      </nav>`;
  }

  return { api, hm, DAYS, fmtDay, AR_DAYS, fmtDayAr, arRoom, mondayOf, addDays, today, heartbeat, header };
})();
