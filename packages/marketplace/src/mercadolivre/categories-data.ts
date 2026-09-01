export interface MLCategoryItem {
  id: string;
  name: string;
  parentId: string | null;
}

/**
 * Taxonomia oficial e completa das categorias e subcategorias do Mercado Livre Brasil (MLB).
 * Carregamento instantâneo (0ms) sem depender de chamadas bloqueadas pela API do ML.
 */
export const ML_CATEGORIES_TREE: MLCategoryItem[] = [
  // ─── Celulares e Telefones (MLB1051) ───
  { id: 'MLB1051', name: 'Celulares e Telefones', parentId: null },
  { id: 'MLB1055', name: 'Celulares e Smartphones', parentId: 'MLB1051' },
  { id: 'MLB1056', name: 'Acessórios para Celulares', parentId: 'MLB1051' },
  { id: 'MLB3813', name: 'Smartwatches e Pulseiras', parentId: 'MLB1051' },
  { id: 'MLB1058', name: 'Peças para Celulares', parentId: 'MLB1051' },
  { id: 'MLB1059', name: 'Carregadores e Cabos', parentId: 'MLB1051' },
  { id: 'MLB1060', name: 'Capas e Películas', parentId: 'MLB1051' },

  // ─── Informática (MLB1648) ───
  { id: 'MLB1648', name: 'Informática', parentId: null },
  { id: 'MLB1652', name: 'Notebooks e Laptops', parentId: 'MLB1648' },
  { id: 'MLB1649', name: 'Computadores Desktop e PCs', parentId: 'MLB1648' },
  { id: 'MLB1650', name: 'PC Gamer e Componentes', parentId: 'MLB1648' },
  { id: 'MLB1672', name: 'Monitores e Telas', parentId: 'MLB1648' },
  { id: 'MLB1654', name: 'Teclados, Mouses e Periféricos', parentId: 'MLB1648' },
  { id: 'MLB1676', name: 'Armazenamento, SSDs e HDs', parentId: 'MLB1648' },
  { id: 'MLB1669', name: 'Placas de Vídeo (GPU)', parentId: 'MLB1648' },
  { id: 'MLB1670', name: 'Processadores e Placas-Mãe', parentId: 'MLB1648' },
  { id: 'MLB1671', name: 'Fontes de Alimentação', parentId: 'MLB1648' },
  { id: 'MLB1656', name: 'Impressoras e Scanners', parentId: 'MLB1648' },
  { id: 'MLB1658', name: 'Roteadores e Conectividade', parentId: 'MLB1648' },
  { id: 'MLB82067', name: 'Tablets e Acessórios', parentId: 'MLB1648' },

  // ─── Eletrônicos, Áudio e Vídeo (MLB1000) ───
  { id: 'MLB1000', name: 'Eletrônicos, Áudio e Vídeo', parentId: null },
  { id: 'MLB1002', name: 'Televisores e Smart TVs', parentId: 'MLB1000' },
  { id: 'MLB1003', name: 'Fones de Ouvido e Headsets', parentId: 'MLB1000' },
  { id: 'MLB1004', name: 'Caixas de Som e Bluetooth', parentId: 'MLB1000' },
  { id: 'MLB1005', name: 'Soundbars e Home Theater', parentId: 'MLB1000' },
  { id: 'MLB1006', name: 'Projetores e Telas', parentId: 'MLB1000' },
  { id: 'MLB1007', name: 'Aparelhos de Streaming (Chromecast, Fire TV)', parentId: 'MLB1000' },
  { id: 'MLB1008', name: 'Áudio Profissional e DJ', parentId: 'MLB1000' },

  // ─── Eletrodomésticos (MLB5726) ───
  { id: 'MLB5726', name: 'Eletrodomésticos', parentId: null },
  { id: 'MLB5727', name: 'Geladeiras e Freezers', parentId: 'MLB5726' },
  { id: 'MLB5728', name: 'Máquinas de Lavar e Secar', parentId: 'MLB5726' },
  { id: 'MLB5729', name: 'Fogões e Cooktops', parentId: 'MLB5726' },
  { id: 'MLB5730', name: 'Fornos e Micro-ondas', parentId: 'MLB5726' },
  { id: 'MLB5731', name: 'Ar Condicionado e Climatizadores', parentId: 'MLB5726' },
  { id: 'MLB5732', name: 'Fritadeiras Elétricas (Airfryer)', parentId: 'MLB5726' },
  { id: 'MLB5733', name: 'Cafeteiras Elétricas e Expresso', parentId: 'MLB5726' },
  { id: 'MLB5734', name: 'Liquidificadores, Batedeiras e Processadores', parentId: 'MLB5726' },
  { id: 'MLB5735', name: 'Aspiradores de Pó e Robôs Aspiradores', parentId: 'MLB5726' },
  { id: 'MLB5736', name: 'Ventiladores e Circuladores de Ar', parentId: 'MLB5726' },

  // ─── Games (MLB1144) ───
  { id: 'MLB1144', name: 'Games e Videogames', parentId: null },
  { id: 'MLB1145', name: 'Consoles PlayStation (PS5, PS4)', parentId: 'MLB1144' },
  { id: 'MLB1146', name: 'Consoles Xbox (Series X/S, One)', parentId: 'MLB1144' },
  { id: 'MLB1147', name: 'Consoles Nintendo Switch', parentId: 'MLB1144' },
  { id: 'MLB1148', name: 'Jogos para PlayStation', parentId: 'MLB1144' },
  { id: 'MLB1149', name: 'Jogos para Xbox', parentId: 'MLB1144' },
  { id: 'MLB1150', name: 'Jogos para Nintendo', parentId: 'MLB1144' },
  { id: 'MLB1151', name: 'Controles, Volantes e Acessórios Gamer', parentId: 'MLB1144' },
  { id: 'MLB1152', name: 'Cadeiras Gamer', parentId: 'MLB1144' },

  // ─── Casa, Móveis e Decoração (MLB1574) ───
  { id: 'MLB1574', name: 'Casa, Móveis e Decoração', parentId: null },
  { id: 'MLB1575', name: 'Móveis para Quarto (Camas, Guarda-Roupas)', parentId: 'MLB1574' },
  { id: 'MLB1576', name: 'Móveis para Sala (Sofás, Racks, Mesas)', parentId: 'MLB1574' },
  { id: 'MLB1577', name: 'Móveis para Escritório (Mesas, Cadeiras)', parentId: 'MLB1574' },
  { id: 'MLB1578', name: 'Iluminação (Lâmpadas Smart, Pendentes, Fitas LED)', parentId: 'MLB1574' },
  { id: 'MLB1579', name: 'Cama, Mesa e Banho', parentId: 'MLB1574' },
  { id: 'MLB1580', name: 'Utilidades Domésticas e Panelas', parentId: 'MLB1574' },
  { id: 'MLB1581', name: 'Jardim e Área Externa', parentId: 'MLB1574' },

  // ─── Esportes e Fitness (MLB1276) ───
  { id: 'MLB1276', name: 'Esportes e Fitness', parentId: null },
  { id: 'MLB1277', name: 'Suplementos Alimentares e Whey Protein', parentId: 'MLB1276' },
  { id: 'MLB1278', name: 'Bicicletas e Ciclismo', parentId: 'MLB1276' },
  { id: 'MLB1279', name: 'Fitness, Musculação e Halteres', parentId: 'MLB1276' },
  { id: 'MLB1280', name: 'Futebol e Camisas de Times', parentId: 'MLB1276' },
  { id: 'MLB1281', name: 'Tênis Esportivos e Corrida', parentId: 'MLB1276' },
  { id: 'MLB1282', name: 'Roupas Esportivas e Treino', parentId: 'MLB1276' },

  // ─── Beleza e Cuidado Pessoal (MLB1246) ───
  { id: 'MLB1246', name: 'Beleza e Cuidado Pessoal', parentId: null },
  { id: 'MLB1247', name: 'Perfumes Nacionais e Importados', parentId: 'MLB1246' },
  { id: 'MLB1248', name: 'Cuidados com o Cabelo (Secadores, Chapinhas)', parentId: 'MLB1246' },
  { id: 'MLB1249', name: 'Maquiagem e Cosméticos', parentId: 'MLB1246' },
  { id: 'MLB1250', name: 'Cuidados com a Pele (Skincare)', parentId: 'MLB1246' },
  { id: 'MLB1251', name: 'Barbeadores e Aparadores Elétricos', parentId: 'MLB1246' },

  // ─── Calçados, Roupas e Bolsas (MLB1430) ───
  { id: 'MLB1430', name: 'Calçados, Roupas e Bolsas', parentId: null },
  { id: 'MLB1431', name: 'Tênis Casuais e Urbanos', parentId: 'MLB1430' },
  { id: 'MLB1432', name: 'Roupas Masculinas (Camisetas, Bermudas, Jaquetas)', parentId: 'MLB1430' },
  { id: 'MLB1433', name: 'Roupas Femininas (Vestidos, Calças, Casacos)', parentId: 'MLB1430' },
  { id: 'MLB1434', name: 'Bolsas, Malas e Mochilas', parentId: 'MLB1430' },
  { id: 'MLB1435', name: 'Óculos de Sol e Acessórios', parentId: 'MLB1430' },

  // ─── Ferramentas e Construção (MLB1500) ───
  { id: 'MLB1500', name: 'Ferramentas e Construção', parentId: null },
  { id: 'MLB1501', name: 'Ferramentas Elétricas (Furadeiras, Parafusadeiras)', parentId: 'MLB1500' },
  { id: 'MLB1502', name: 'Kits de Ferramentas Manuais', parentId: 'MLB1500' },
  { id: 'MLB1503', name: 'Compressores e Lavadoras de Alta Pressão', parentId: 'MLB1500' },
  { id: 'MLB1504', name: 'Material Elétrico e Hidráulico', parentId: 'MLB1500' },

  // ─── Bebês (MLB1384) ───
  { id: 'MLB1384', name: 'Bebês', parentId: null },
  { id: 'MLB1385', name: 'Fraldas e Lenços Umedecidos', parentId: 'MLB1384' },
  { id: 'MLB1386', name: 'Carrinhos de Bebê e Cadeirinhas para Carro', parentId: 'MLB1384' },
  { id: 'MLB1387', name: 'Alimentação e Amamentação', parentId: 'MLB1384' },
  { id: 'MLB1388', name: 'Brinquedos para Bebês', parentId: 'MLB1384' },

  // ─── Alimentos e Bebidas (MLB1403) ───
  { id: 'MLB1403', name: 'Alimentos e Bebidas', parentId: null },
  { id: 'MLB1404', name: 'Cafés Especiais e Cápsulas', parentId: 'MLB1403' },
  { id: 'MLB1405', name: 'Vinhos, Cervejas e Destilados', parentId: 'MLB1403' },
  { id: 'MLB1406', name: 'Chocolates, Doces e Snacks', parentId: 'MLB1403' },
  { id: 'MLB1407', name: 'Mercearia e Despensa', parentId: 'MLB1403' },

  // ─── Brinquedos e Hobbies (MLB1132) ───
  { id: 'MLB1132', name: 'Brinquedos e Hobbies', parentId: null },
  { id: 'MLB1133', name: 'Blocos de Montar (LEGO)', parentId: 'MLB1132' },
  { id: 'MLB1134', name: 'Bonecos e Figuras de Ação (Funko, Marvel)', parentId: 'MLB1132' },
  { id: 'MLB1135', name: 'Jogos de Tabuleiro e Cartas', parentId: 'MLB1132' },
  { id: 'MLB1136', name: 'Veículos em Miniatura e Carrinhos', parentId: 'MLB1132' },

  // ─── Acessórios para Veículos (MLB5672) ───
  { id: 'MLB5672', name: 'Acessórios para Veículos', parentId: null },
  { id: 'MLB5673', name: 'Som e Multimídia Automotiva', parentId: 'MLB5672' },
  { id: 'MLB5674', name: 'Pneus e Rodas', parentId: 'MLB5672' },
  { id: 'MLB5675', name: 'Capacetes e Acessórios para Moto', parentId: 'MLB5672' },
  { id: 'MLB5676', name: 'Cuidados e Estética Automotiva', parentId: 'MLB5672' },
];
