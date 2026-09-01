# Checklist de Submissao — Achadinho PRO

## Antes de Enviar

### Manifest.json
- [x] Descricao com max 132 caracteres
- [x] URL de desenvolvimento removida (worf.replit.dev)
- [x] API URL apontando para producao (achadinhopro.com.br)
- [x] Versao atualizada (1.1.0)
- [x] Permissao `alarms` adicionada
- [x] Icones 16, 48, 128 presentes na pasta icons/

### Imagens (criar antes de enviar)
- [ ] Icone 128x128 PNG (arte 96x96 com 16px padding)
- [ ] Screenshot 1: Aba Produto — extracao de produto com link gerado (1280x800)
- [ ] Screenshot 2: Aba Lista — listas de produtos salvas (1280x800)
- [ ] Screenshot 3: Aba Automacao — agendamento configurado (1280x800)
- [ ] Screenshot 4: Aba Busca — palavras-chave em execucao (1280x800)
- [ ] Promo tile 440x280 PNG
- [ ] Marquee 1400x560 (opcional)

### Dashboard — Store Listing
- [ ] Nome: "Achadinho PRO — Afiliado Mercado Livre"
- [ ] Descricao completa: copiar de store-description.md
- [ ] Categoria: Shopping
- [ ] Idioma principal: Portugues (Brasil)
- [ ] Site: https://achadinhopro.com.br
- [ ] Email de suporte: suporte@achadinhopro.com.br

### Dashboard — Privacy
- [ ] URL da politica de privacidade: https://achadinhopro.com.br/privacy
- [ ] Single Purpose preenchido
- [ ] Justificativa de cada permissao preenchida (copiar de store-description.md)
- [ ] Data Use Disclosure preenchido (checkboxes)
- [ ] Host permissions justificadas

### Hospedagem
- [ ] Politica de privacidade publicada em https://achadinhopro.com.br/privacy
- [ ] Pagina acessivel publicamente (testar em aba anonima)

### Codigo — Compliance
- [x] Nenhum `eval()` ou codigo remoto (MV3 compliance)
- [x] Nenhum link de afiliado gerado sem acao explicita do usuario
- [x] Produtos so salvos COM link de afiliado (5 bugs corrigidos)
- [x] Divulgacao de afiliado na descricao da loja
- [x] Divulgacao de afiliado na politica de privacidade
- [ ] Divulgacao de afiliado no UI da extensao (adicionar tooltip ou info)

### Conta de Desenvolvedor
- [ ] Registrado em https://chrome.google.com/webstore/devconsole
- [ ] Taxa de $5 USD paga
- [ ] Email verificado
- [ ] Politica de privacidade configurada nas configuracoes da conta

## Processo de Envio
1. Zippar a pasta `achadinho-pro/` (excluir `store-listing/`)
2. Fazer upload do ZIP no Developer Dashboard
3. Preencher Store Listing com os dados de store-description.md
4. Preencher Privacy tab com justificativas
5. Upload das imagens (screenshots + icons)
6. Submeter para revisao

## Apos Envio
- Revisao leva 1-3 dias uteis (pode levar mais na primeira vez)
- Se rejeitado, verificar o motivo e corrigir
- Rejeicoes comuns: permissoes excessivas, falta de politica de privacidade, divulgacao de afiliado insuficiente
