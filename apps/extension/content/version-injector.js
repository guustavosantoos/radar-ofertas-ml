// Injeta a versão da extensão na página do webapp para detecção
(function() {
  const version = chrome.runtime.getManifest().version;

  // Expõe via meta tag para o webapp detectar
  const meta = document.createElement('meta');
  meta.name = 'achadinho-extension-version';
  meta.content = version;
  document.head.appendChild(meta);

  // Dispara evento customizado para o webapp React capturar
  window.dispatchEvent(new CustomEvent('achadinho-extension-detected', {
    detail: { version }
  }));

  // Re-dispara após um delay para garantir que o React já montou
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('achadinho-extension-detected', {
      detail: { version }
    }));
  }, 2000);
})();
