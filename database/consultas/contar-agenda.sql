-- Apoio ao requisito 3: total com os mesmos filtros da agenda.
-- Bind: $usuario, $encontro (id ou NULL), $somenteFuturos, $somenteAgendados, $agora.
-- Finalidade: manter o total correto mesmo em página vazia.
SELECT count(*) AS total FROM inscricoes_encontro i
JOIN encontros e ON e.id = i.encontro_id
WHERE i.usuario_id = $usuario AND ($encontro::integer IS NULL OR i.encontro_id = $encontro)
  AND (NOT $somenteFuturos::boolean OR e.inicio_em > $agora::timestamptz)
  AND (NOT $somenteAgendados::boolean OR e.situacao = 'AGENDADO');
