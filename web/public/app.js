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

  function mondayOf(iso) {
    const d = new Date(`${iso}T00:00:00`);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  function addDays(iso, n) {
    const d = new Date(`${iso}T00:00:00`);
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }
  const today = () => new Date().toISOString().slice(0, 10);

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
        <a href="/" ${active === 'home' ? 'style="background:rgba(255,255,255,.3)"' : ''}>Accueil</a>
        <a href="/edt.html" ${active === 'edt' ? 'style="background:rgba(255,255,255,.3)"' : ''}>Emplois du temps</a>
        <a href="/prof.html" ${active === 'prof' ? 'style="background:rgba(255,255,255,.3)"' : ''}>Espace professeur</a>
      </nav>`;
  }

  return { api, hm, DAYS, fmtDay, mondayOf, addDays, today, heartbeat, header };
})();
