-- Apoio ao requisito 1: total da mesma seleção para paginação sem duplicação.
-- Bind: $ciclo. Finalidade: preservar meta.total do contrato HTTP.
SELECT count(*) AS total FROM participacoes_leitura WHERE ciclo_id = $ciclo;
