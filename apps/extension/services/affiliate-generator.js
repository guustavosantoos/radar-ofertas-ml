const ML_BASE_URL = 'https://www.mercadolivre.com.br';
const ML_AFFILIATE_API = '/affiliate-program/api/v2/stripe/user';

export async function generateShortLink(originalUrl, tabId) {
  if (!originalUrl) {
    throw new Error('URL não fornecida');
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: _generateLinkInPageContext,
      args: [originalUrl, ML_BASE_URL, ML_AFFILIATE_API],
      world: 'MAIN',
    });

    const result = results[0]?.result;

    if (result?.success) {
      return {
        success: true,
        short_link: result.short_link,
        original_url: originalUrl,
        response: result.data,
      };
    }

    return {
      success: false,
      short_link: null,
      original_url: originalUrl,
      error: result?.error || 'Erro desconhecido',
    };
  } catch (error) {
    return {
      success: false,
      short_link: null,
      original_url: originalUrl,
      error: error.message,
    };
  }
}

function _generateLinkInPageContext(originalUrl, baseUrl, affiliateApi) {
  function getCsrfToken() {
    const metaTag = document.querySelector('meta[name="csrf-token"]');
    if (metaTag) return metaTag.getAttribute('content');

    const scripts = document.querySelectorAll('script:not([src])');
    for (const script of scripts) {
      const text = script.textContent || '';
      const match = text.match(/csrfToken['":\s]+['"]([^'"]+)['"]/);
      if (match) return match[1];
      const match2 = text.match(/_csrf['":\s]+['"]([^'"]+)['"]/);
      if (match2) return match2[1];
    }

    const cookieMatch = document.cookie.match(/_csrf=([^;]+)/);
    if (cookieMatch) return cookieMatch[1];

    return null;
  }

  return (async () => {
    try {
      const csrfToken = getCsrfToken();

      const headers = {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
      };

      if (csrfToken) {
        headers['x-csrf-token'] = csrfToken;
      }

      const tagsResponse = await fetch(`${baseUrl}${affiliateApi}/tags`, {
        method: 'GET',
        credentials: 'include',
        headers,
      });

      if (!tagsResponse.ok) {
        return {
          success: false,
          error: 'Você precisa estar logado no Mercado Livre Afiliados',
        };
      }

      const tagsData = await tagsResponse.json();
      const tags = tagsData.tags || tagsData;

      if (!Array.isArray(tags) || tags.length === 0) {
        return {
          success: false,
          error: 'Nenhuma tag de afiliado encontrada. Cadastre-se no programa.',
        };
      }

      const tagId = tags[0].id || tags[0];

      const linkResponse = await fetch(`${baseUrl}${affiliateApi}/links`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({
          url: originalUrl,
          tag_id: tagId,
        }),
      });

      if (!linkResponse.ok) {
        const errorText = await linkResponse.text();
        return {
          success: false,
          error: `Erro ao gerar link: ${linkResponse.status} - ${errorText}`,
        };
      }

      const linkData = await linkResponse.json();
      const shortLink = linkData.short_url || linkData.short_link || linkData.url || null;

      // Só aceitar short link de afiliado meli.la — nunca uma URL de redirect/produto
      // (click1/produto.mercadolivre), que não atribui comissão.
      if (shortLink && shortLink.startsWith('https://meli.la/')) {
        return { success: true, short_link: shortLink, data: linkData };
      }

      return { success: false, error: 'Link gerado não é short link de afiliado meli.la' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  })();
}

export async function generateShortLinksInBatch(urls, tabId, onProgress = null) {
  const results = [];

  for (let i = 0; i < urls.length; i++) {
    try {
      const result = await generateShortLink(urls[i], tabId);
      results.push(result);

      if (onProgress) {
        onProgress(i, urls.length, result);
      }

      if (i < urls.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    } catch (error) {
      results.push({
        success: false,
        short_link: null,
        original_url: urls[i],
        error: error.message,
      });
    }
  }

  return results;
}

export async function checkMlAffiliateSession(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        return (async () => {
          try {
            const response = await fetch(
              'https://www.mercadolivre.com.br/affiliate-program/api/v2/stripe/user/tags',
              { method: 'GET', credentials: 'include' }
            );
            return { loggedIn: response.ok, status: response.status };
          } catch (e) {
            return { loggedIn: false, error: e.message };
          }
        })();
      },
      world: 'MAIN',
    });

    return results[0]?.result || { loggedIn: false };
  } catch (error) {
    return { loggedIn: false, error: error.message };
  }
}
