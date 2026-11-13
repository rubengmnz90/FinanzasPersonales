import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'e2e@test.io';
const INITIAL = 'clave-inicial-e2e';
const NEW_PASS = 'clave-nueva-segura-1';

async function login(page: Page, pass: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Contraseña').fill(pass);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

test.describe.serial('app', () => {
  test('login con contraseña inicial obliga a cambiarla antes de usar la app', async ({ page }) => {
    await page.goto('/flujo');
    await expect(page).toHaveURL(/\/login/);
    await login(page, 'incorrecta');
    await expect(page.getByRole('alert')).toContainText('incorrectos');
    await login(page, INITIAL);
    await expect(page.getByRole('heading', { name: 'Elige tu contraseña' })).toBeVisible();
    await page.getByLabel('Contraseña actual').fill(INITIAL);
    await page.getByLabel('Contraseña nueva', { exact: true }).fill(NEW_PASS);
    await page.getByLabel('Repetir contraseña nueva').fill(NEW_PASS);
    await page.getByRole('button', { name: 'Guardar contraseña' }).click();
    await expect(page.getByRole('heading', { name: 'Flujo de caja' })).toBeVisible();
  });

  test('flujo: alta rápida con fórmula, rango de fechas y persistencia', async ({ page }) => {
    await login(page, NEW_PASS);
    await expect(page.getByRole('heading', { name: 'Flujo de caja' })).toBeVisible();
    // Rango: todo el 2026 (datos importados del Excel)
    await page.getByRole('button', { name: 'Año 2026' }).click();
    await expect(page.getByRole('grid', { name: 'Movimientos' }).getByRole('row').nth(3)).toBeVisible();

    const form = page.getByRole('form', { name: 'Alta rápida' });
    await form.getByLabel('Fecha').fill('2026-11-14');
    await form.getByLabel('Item').fill('Prueba e2e');
    await form.getByLabel('Monto').fill('=1000+500');
    await form.getByRole('button', { name: 'Agregar' }).click();
    const row = page.getByRole('row').filter({ hasText: 'Prueba e2e' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('1.500');

    await page.reload();
    await page.getByRole('button', { name: 'Año 2026' }).click();
    await page.getByPlaceholder('Buscar item, nota o cuenta…').fill('Prueba e2e');
    await expect(page.getByRole('row').filter({ hasText: 'Prueba e2e' })).toContainText('1.500');

    // Rango acotado que excluye el movimiento
    await page.getByLabel('Desde').fill('2026-01-01');
    await page.getByLabel('Hasta').fill('2026-01-31');
    await expect(page.getByRole('row').filter({ hasText: 'Prueba e2e' })).toHaveCount(0);
  });

  test('flujo: editar una celda con teclado (fórmula) recalcula', async ({ page }) => {
    await login(page, NEW_PASS);
    await page.getByRole('button', { name: 'Año 2026' }).click();
    await page.getByPlaceholder('Buscar item, nota o cuenta…').fill('Prueba e2e');
    const cell = page.getByRole('row').filter({ hasText: 'Prueba e2e' }).locator('[data-col=expense]');
    await cell.click();
    await page.keyboard.type('=2.000*3');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('row').filter({ hasText: 'Prueba e2e' })).toContainText('6.000');
  });

  test('planes: totales del Excel y valor manual en Otros gastos', async ({ page }) => {
    await login(page, NEW_PASS);
    await page.getByRole('link', { name: /Planes/ }).click();
    await page.getByLabel('Plan', { exact: true }).selectOption({ label: '2026 · Proyección 2026' });
    await expect(page.getByText('Neto del año')).toBeVisible();
    // Neto 2026 Fin de mes 15.225.138 + Quincena 20.660.518 = 35.885.656
    await expect(page.locator('.kpi', { hasText: 'Neto del año' })).toContainText('35.885.656');
    await page.getByRole('tab', { name: /Quincena/ }).click();
    await expect(page.getByRole('grid', { name: 'Plan Quincena' })).toBeVisible();
    // celda manual (octubre = 0 pisa los 1.000.000 calculados) marcada
    await expect(page.locator('.dg-cell.ovr').first()).toBeVisible();
  });

  test('planes: nuevo plan quincenal, clonar y comparar', async ({ page }) => {
    await login(page, NEW_PASS);
    await page.getByRole('link', { name: /Planes/ }).click();
    await page.getByRole('button', { name: '+ Nuevo plan' }).click();
    await page.getByPlaceholder('Nombre (p. ej. Plan B)').fill('Plan e2e');
    await page.getByLabel('Año').fill('2030');
    await page.getByRole('button', { name: 'Crear plan' }).click();
    await expect(page.getByRole('tab', { name: /Quincena/ })).toBeVisible();
    await expect(page.getByLabel('Plan', { exact: true })).toContainText('2030 · Plan e2e');
    await expect(page.getByLabel('Plan', { exact: true })).toHaveValue(/.+/);
    await expect(page.locator('.kpi', { hasText: 'Ingresos del año' })).toContainText('0');
    await page.getByLabel('Tipo de fila').selectOption('income');
    const nuevaFila = page.getByPlaceholder(/Nueva fila en/);
    await nuevaFila.fill('Sueldo');
    await expect(nuevaFila).toHaveValue('Sueldo');
    await page.getByRole('button', { name: 'Agregar fila' }).click();
    const sueldo = page.getByRole('grid', { name: /Plan/ }).getByRole('row').filter({ hasText: 'Sueldo' });
    await sueldo.locator('[data-col=m1]').click();
    await page.keyboard.type('5.500.000');
    await page.keyboard.press('Enter');
    await expect(page.locator('.kpi', { hasText: 'Ingresos del año' })).toContainText('5.500.000');
    await page.getByRole('button', { name: 'Clonar (escenario)' }).click();
    await page.getByLabel('Nombre del escenario').fill('Escenario e2e');
    await page.getByRole('button', { name: 'Clonar', exact: true }).click();
    await expect(page.getByLabel('Plan', { exact: true })).toContainText('Escenario e2e');
  });

  test('todas las páginas cargan con datos reales y sin errores de consola', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await login(page, NEW_PASS);
    for (const [name, heading] of [
      ['Flujo', 'Flujo de caja'], ['Planes', 'Planes y proyección'], ['Cuentas', 'Cuentas'], ['Tarjetas', 'Tarjetas'], ['Ahorro', 'Ahorro'],
      ['Préstamos', 'Préstamos'], ['Deudas personales', 'Deudas personales'], ['Distribución', 'Distribución de compras'],
      ['Resúmenes', 'Resúmenes'], ['Conectar IA', 'Conectar una IA'],
    ] as const) {
      await page.getByRole('link', { name: new RegExp(name) }).click();
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: `test-results/page-${name.replace(/\W/g, '')}.png` });
    }
    // el 401 es la comprobación de sesión previa al login
    expect(errors.filter((e) => !/favicon|status of 401/.test(e))).toEqual([]);
  });

  test('préstamos y distribución muestran los datos migrados', async ({ page }) => {
    await login(page, NEW_PASS);
    await page.getByRole('link', { name: /Deudas personales/ }).click();
    await expect(page.getByRole('heading', { name: 'Quién me presta: Esposa' })).toBeVisible();
    await expect(page.locator('.kpi', { hasText: 'Total que debes' })).toContainText('21.788.789');
    await expect(page.getByRole('button', { name: /^Deuda Casa \d/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Deuda Casamiento/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Deuda Normal/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Préstamo \(Boda\)/ })).toBeVisible();
    await page.getByRole('link', { name: /Distribución/ }).click();
    await expect(page.locator('.kpi', { hasText: 'Total Emma' })).toContainText('92.652');
    await expect(page.locator('.kpi', { hasText: 'Total Yo' })).toContainText('312.233');
  });

  test('cuentas: solo bancos y cajas; Vibra Lejana con sus movimientos; las tarjetas y el ahorro van aparte', async ({ page }) => {
    await login(page, NEW_PASS);
    await page.getByRole('link', { name: /^Cuentas/ }).click();
    await expect(page.getByRole('button', { name: 'Abrir relatorio de GNB' })).toContainText('0971185507');
    await expect(page.getByRole('button', { name: 'Abrir relatorio de GNB' })).toContainText('En el flujo');
    await expect(page.getByRole('button', { name: 'Abrir relatorio de Familiar', exact: true })).toContainText('2946999');
    await expect(page.getByRole('button', { name: 'Abrir relatorio de Efectivo' })).toContainText('Fuera del flujo');
    await expect(page.getByRole('button', { name: 'Abrir movimientos de Vibra Lejana' })).toContainText('1.189.912');
    await expect(page.getByRole('button', { name: 'Abrir movimientos de Vibra Lejana' })).toContainText('rubengmnz90@gmail.com');
    await expect(page.getByRole('button', { name: /Tarjeta/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Ahorro Coomecipar/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Deuda Casa/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Abrir relatorio de (Coomecipar|Familiar Vibra Lejana)$/ })).toHaveCount(0);
    await page.screenshot({ path: 'test-results/page-CuentasResumen.png' });
    await page.getByRole('button', { name: 'Abrir movimientos de Vibra Lejana' }).click();
    const grid = page.getByRole('grid', { name: 'Movimientos de la caja' });
    await expect(grid).toContainText('Segunda cuota');
    await expect(page.getByText('Saldo:').first()).toContainText('1.189.912');
    await page.screenshot({ path: 'test-results/page-CuentasMovimientos.png' });
  });

  test('cuentas: marcar una cuenta para el flujo la muestra en el alta rápida', async ({ page }) => {
    await login(page, NEW_PASS);
    const form = page.getByRole('form', { name: 'Alta rápida' });
    await form.getByRole('combobox', { name: 'Cuenta' }).click();
    await expect(page.getByRole('option', { name: 'Efectivo' })).toHaveCount(0);
    await expect(page.getByRole('option', { name: /^Tarjeta/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('[cmdk-list]')).toHaveCount(0);
    await page.getByRole('link', { name: /^Cuentas/ }).click();
    await page.getByRole('button', { name: 'Editar Efectivo' }).click({ force: true });
    await page.getByRole('dialog').getByLabel('Usar en el flujo de caja').check();
    await page.getByRole('dialog').getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Abrir relatorio de Efectivo' })).toContainText('En el flujo');
    // se desmarca para no afectar a las demás pruebas
    await page.getByRole('button', { name: 'Editar Efectivo' }).click({ force: true });
    await page.getByRole('dialog').getByLabel('Usar en el flujo de caja').uncheck();
    await page.getByRole('dialog').getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Abrir relatorio de Efectivo' })).toContainText('Fuera del flujo');
  });

  test('tarjetas y ahorro: intocable, tocable y relatorio del ahorro', async ({ page }) => {
    await login(page, NEW_PASS);
    await page.getByRole('link', { name: /^Tarjetas/ }).click();
    await expect(page.getByRole('button', { name: 'Abrir Tarjeta GNB' })).toContainText('7.000.000');
    await expect(page.getByRole('button', { name: 'Abrir Tarjeta Coomecipar' })).toContainText('3.000.000');
    await page.screenshot({ path: 'test-results/page-Tarjetas.png', fullPage: true });
    await page.getByRole('link', { name: /^Ahorro/ }).click();
    await expect(page.locator('.kpi', { hasText: 'Ahorros totales' })).toContainText('3.494.460');
    await expect(page.locator('.kpi', { hasText: 'Monto intocable' })).toContainText('3.957.500');
    await expect(page.locator('.kpi', { hasText: 'Saldo que puedo tocar' })).toContainText('463.040');
    const goals = page.getByLabel('Objetivos de Ahorro Coomecipar');
    await expect(goals).toContainText('Aguinaldo');
    await expect(goals.getByRole('listitem').filter({ hasText: 'Aguinaldo' })).toContainText('Intocable');
    await expect(goals.getByRole('listitem').filter({ hasText: 'Aguinaldo' })).toContainText('2.050.000');
    await expect(goals.getByRole('listitem').filter({ hasText: 'Vacaciones' })).toContainText('Intocable');
    await expect(goals.getByRole('listitem').filter({ hasText: 'Emma' })).toContainText('67.500');
    await expect(goals.getByRole('listitem').filter({ hasText: /^Ahorro/ }).first()).not.toContainText('Intocable');
    await page.screenshot({ path: 'test-results/page-TarjetasAhorro.png', fullPage: true });
    // liberar y volver a marcar un objetivo
    await page.getByRole('button', { name: 'Marcar Aguinaldo como tocable' }).click();
    await expect(page.locator('.kpi', { hasText: 'Monto intocable' })).toContainText('1.907.500');
    await page.getByRole('button', { name: 'Marcar Aguinaldo como intocable' }).click();
    await expect(page.locator('.kpi', { hasText: 'Monto intocable' })).toContainText('3.957.500');
    // nuevo objetivo
    await page.getByLabel('Nombre del objetivo').fill('Moto');
    await page.getByRole('button', { name: 'Agregar objetivo' }).click();
    await expect(goals).toContainText('Moto');
    await page.getByRole('button', { name: 'Marcar Moto como intocable' }).click();
    await expect(goals.getByRole('listitem').filter({ hasText: 'Moto' })).toContainText('Intocable');
  });

  test('tarjetas: cargar una compra usa cupo y sube la deuda', async ({ page }) => {
    await login(page, NEW_PASS);
    await page.getByRole('link', { name: /^Tarjetas/ }).click();
    const tile = page.getByRole('button', { name: 'Abrir Tarjeta GNB' });
    await tile.click();
    await page.getByRole('button', { name: 'Cargar compra' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Monto de la compra').fill('50000');
    await dlg.getByLabel('Concepto de la compra').fill('Super e2e');
    await expect(dlg).toContainText('6.902.460');
    await dlg.getByRole('button', { name: 'Cargar compra' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(tile).toContainText('6.902.460');
    await expect(page.getByRole('grid', { name: 'Movimientos de la tarjeta' })).toContainText('Super e2e');
    await page.screenshot({ path: 'test-results/page-TarjetaCompra.png', fullPage: true });
  });

  test('ahorro: personas que me deben (Charlie, Osky, Amor)', async ({ page }) => {
    await login(page, NEW_PASS);
    await page.getByRole('link', { name: /^Ahorro/ }).click();
    const region = page.getByRole('region', { name: 'Me deben de mi ahorro' });
    await expect(region).toContainText('Nadie te debe');
    await region.getByRole('button', { name: 'Nueva persona' }).click();
    await page.getByRole('dialog').getByLabel('Nombre').fill('Charlie');
    await page.getByRole('dialog').getByRole('button', { name: /^(Crear|Guardar)$/ }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByLabel('Personas que me deben')).toContainText('Charlie');
    await expect(region.getByRole('button', { name: 'Recibí un pago' })).toBeDisabled();
    await page.screenshot({ path: 'test-results/page-MeDeben.png', fullPage: true });
  });

  test('historial: lo que se hace queda registrado y se puede deshacer', async ({ page }) => {
    await login(page, NEW_PASS);
    await page.getByRole('link', { name: /^Tarjetas/ }).click();
    await page.getByRole('button', { name: 'Abrir Tarjeta GNB' }).click();
    await page.getByRole('button', { name: 'Cargar compra' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Monto de la compra').fill('12345');
    await dlg.getByLabel('Concepto de la compra').fill('Historial e2e');
    await dlg.getByRole('button', { name: 'Cargar compra' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('link', { name: /^Historial/ }).click();
    const item = page.getByRole('listitem').filter({ hasText: /Creó movimiento de cuenta: Historial e2e/ }).first();
    await expect(item).toContainText('Creó');
    await expect(item).toContainText('Yo');
    await page.screenshot({ path: 'test-results/page-HistorialLista.png', fullPage: true });
    await item.getByRole('button', { name: /^Deshacer:/ }).click();
    await item.getByRole('button', { name: 'Sí, deshacer' }).click();
    await expect(item).toContainText('Deshecho');
    // la compra ya no está en la tarjeta
    const accs = await (await page.request.get('/api/accounts')).json();
    const gnb = accs.find((a: any) => a.name === 'Tarjeta GNB');
    expect(gnb.balance).toBe(6902460);
  });

  test('préstamos con cuotas: Coomecipar y Vibra Lejana, marcar pagada y nuevo préstamo en la proyección', async ({ page }) => {
    await login(page, NEW_PASS);
    await page.getByRole('link', { name: /Préstamos/ }).click();
    const coo = page.getByRole('region', { name: 'Préstamo Préstamo Coomecipar' });
    await expect(coo).toContainText('3 de 3 cuotas pagadas');
    await expect(coo).toContainText('10.000.000');
    await expect(coo).toContainText('828.867');
    await expect(coo).toContainText('883.114');
    const vib = page.getByRole('region', { name: 'Préstamo Préstamo equipos Vibra Lejana' });
    await expect(vib).toContainText('3 de 12 cuotas pagadas');
    await expect(vib).toContainText('1.059.737');
    await page.screenshot({ path: 'test-results/page-PrestamosCuotas.png', fullPage: true });
    // pagar la cuota 4 de Vibra Lejana: sale de la caja
    await page.getByRole('button', { name: 'Marcar pagada cuota 4 de Préstamo equipos Vibra Lejana' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Marcar pagada' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(vib).toContainText('4 de 12 cuotas pagadas');
    // sumar una cuota a Coomecipar
    await coo.getByRole('button', { name: 'Agregar cuota' }).click();
    await page.getByRole('dialog').getByLabel('Monto de la cuota').fill('883114');
    await page.getByRole('dialog').getByLabel('Vencimiento').fill('2026-12-15');
    await page.getByRole('dialog').getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(coo).toContainText('3 de 4 cuotas pagadas');
    // préstamo nuevo en la proyección
    await page.getByRole('button', { name: 'Nuevo préstamo' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Nombre del préstamo').fill('Moto e2e');
    await dlg.getByLabel('Monto de la cuota').fill('300000');
    await dlg.getByLabel('Cantidad de cuotas').fill('3');
    await dlg.getByLabel('Primer vencimiento').fill('2031-01-15');
    await dlg.getByRole('button', { name: 'Crear' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Préstamo Moto e2e' })).toContainText('En la proyección');
    const planned = await (await page.request.get('/api/planned-expenses?from=2031-01-01&to=2031-12-31')).json();
    expect(planned.filter((x: any) => x.concept.startsWith('Moto e2e'))).toHaveLength(3);
    // la caja de Vibra Lejana bajó la cuota
    const accs = await (await page.request.get('/api/accounts')).json();
    expect(accs.find((a: any) => a.name === 'Vibra Lejana').balance).toBe(1189912 - 1059737);
  });

  test('flujo: monto primero, categoría con buscador, cuenta y lo más reciente arriba', async ({ page }) => {
    await login(page, NEW_PASS);
    const form = page.getByRole('form', { name: 'Alta rápida' });
    await expect(form.getByLabel('Monto')).toBeVisible();
    const labels = await form.locator('label').allTextContents();
    expect(labels.slice(0, 5)).toEqual(['Monto', 'Item', 'Categoría', 'Tipo', 'Cuenta']);
    await form.getByLabel('Monto').fill('25.000');
    await form.getByLabel('Item').fill('Café e2e');
    await form.getByRole('combobox', { name: 'Categoría' }).click();
    await page.getByPlaceholder('Escribe para buscar…').fill('comi');
    await page.getByRole('option', { name: /^Comida/ }).first().click();
    await expect(page.locator('[cmdk-list]')).toHaveCount(0);
    await form.getByRole('combobox', { name: 'Cuenta' }).click();
    await page.getByRole('option', { name: /^Familiar/ }).click();
    await expect(page.locator('[cmdk-list]')).toHaveCount(0);
    await form.getByRole('button', { name: 'Agregar movimiento' }).click();
    const grid = page.getByRole('grid', { name: 'Movimientos' });
    const first = grid.getByRole('row').filter({ hasText: 'Café e2e' });
    await expect(first).toContainText('Café e2e');
    await expect(first).toContainText('Comida');
    await expect(first).toContainText('Familiar');
    await expect(first).toContainText('25.000');
    // orden descendente por fecha
    const dates = await grid.locator('[role=row] [data-col=date]').allTextContents();
    expect(dates.length).toBeGreaterThan(3);
    expect([...dates].sort().reverse()).toEqual(dates);
    // el filtro por cuenta muestra solo esa cuenta
    await page.getByRole('button', { name: 'Familiar', exact: true }).click();
    await expect(grid.getByRole('row').first()).toContainText('Café e2e');
    await expect(page.locator('.kpi', { hasText: 'Saldo Familiar' })).toContainText('25.000');
  });

  test('flujo: pasar a ahorro con objetivo, prestar del ahorro y devolver', async ({ page }) => {
    await login(page, NEW_PASS);
    await page.getByRole('button', { name: 'Transferir' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('button', { name: 'Pasar a ahorro' }).click();
    await dlg.getByLabel('Monto').fill('1.000.000');
    await expect(dlg.getByRole('combobox', { name: 'Cuenta de origen' })).toContainText('GNB');
    await expect(dlg.getByRole('combobox', { name: 'Cuenta de destino' })).toContainText('Ahorro Coomecipar');
    await dlg.getByRole('combobox', { name: 'Objetivo del ahorro' }).click();
    await page.getByRole('option', { name: /Vacaciones/ }).click();
    await expect(page.locator('[cmdk-list]')).toHaveCount(0);
    await dlg.getByRole('button', { name: 'Registrar' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const grid = page.getByRole('grid', { name: 'Movimientos' });
    await expect(grid.getByRole('row').filter({ hasText: 'GNB → Ahorro Coomecipar' })).toContainText('Vacaciones');

    await page.getByRole('link', { name: /^Ahorro/ }).click();
    await expect(page.getByLabel('Saldo de Ahorro Coomecipar')).toContainText('4.494.460');
    await expect(page.getByLabel('Objetivos de Ahorro Coomecipar')).toContainText('Vacaciones');
    // préstamo del ahorro a GNB
    await page.getByRole('button', { name: 'Prestar', exact: true }).click();
    const d2 = page.getByRole('dialog');
    await d2.getByLabel('Monto').fill('300.000');
    await d2.getByRole('combobox', { name: 'Objetivo del ahorro' }).click();
    await page.getByRole('option', { name: /Vacaciones/ }).click();
    await expect(page.locator('[cmdk-list]')).toHaveCount(0);
    await d2.getByLabel('Confirmo usar un objetivo intocable').check();
    await d2.getByRole('button', { name: 'Registrar' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.kpi', { hasText: 'Prestado del ahorro' })).toContainText('3.372.555'); // 3.072.555 del Excel + 300.000
    // devolución parcial
    await page.getByRole('button', { name: 'Devolver', exact: true }).click();
    const d3 = page.getByRole('dialog');
    await d3.getByLabel('Monto').fill('100.000');
    await d3.getByRole('combobox', { name: 'Objetivo del ahorro' }).click();
    await page.getByRole('option', { name: /Vacaciones/ }).click();
    await expect(page.locator('[cmdk-list]')).toHaveCount(0);
    await d3.getByRole('button', { name: 'Registrar' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.kpi', { hasText: 'Prestado del ahorro' })).toContainText('3.272.555');
  });

  test('planes: ejecutar plan registra el honorario en la cuenta elegida y no se duplica', async ({ page }) => {
    await login(page, NEW_PASS);
    await page.getByRole('link', { name: /Planes/ }).click();
    await page.getByLabel('Plan', { exact: true }).selectOption({ label: '2030 · Plan e2e' });
    await expect(page.locator('.kpi', { hasText: 'Ingresos del año' })).toContainText('5.500.000');
    await page.getByRole('button', { name: 'Ejecutar plan' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Mes a ejecutar').selectOption({ label: 'Ene 2030' });
    await expect(dlg.getByRole('row').filter({ hasText: 'Sueldo' })).toBeVisible();
    await dlg.getByRole('combobox', { name: 'Cuenta de Sueldo' }).click();
    await page.getByRole('option', { name: 'Familiar', exact: true }).click();
    await expect(page.locator('[cmdk-list]')).toHaveCount(0);
    await dlg.getByRole('button', { name: 'Agregar' }).click();
    await dlg.getByRole('combobox', { name: 'Mover desde' }).click();
    await page.getByRole('option', { name: 'Familiar', exact: true }).click();
    await expect(page.locator('[cmdk-list]')).toHaveCount(0);
    await dlg.getByRole('combobox', { name: 'Mover hacia' }).click();
    await page.getByRole('option', { name: 'GNB' }).click();
    await expect(page.locator('[cmdk-list]')).toHaveCount(0);
    await dlg.getByLabel('Monto a mover').fill('2.000.000');
    await dlg.getByRole('button', { name: 'Ejecutar', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const res = await page.request.get('/api/transactions?from=2030-01-01&to=2030-01-31');
    const rows = await res.json();
    expect(rows.filter((r: any) => r.item === 'Sueldo' && r.accountName === 'Familiar' && r.amount === 5500000)).toHaveLength(1);
    expect(rows.filter((r: any) => r.rowType === 'transfer' && r.accountName === 'Familiar' && r.toAccountName === 'GNB' && r.amount === 2000000)).toHaveLength(1);
    // reabrir: la línea figura como ya ejecutada
    await page.getByRole('button', { name: 'Ejecutar plan' }).click();
    const d2 = page.getByRole('dialog');
    await d2.getByLabel('Mes a ejecutar').selectOption({ label: 'Ene 2030' });
    await expect(d2.getByRole('row').filter({ hasText: 'Sueldo' })).toContainText('Ya ejecutado');
    await page.screenshot({ path: 'test-results/page-EjecutarPlan.png' });
  });

  test('resúmenes: reporte de sanidad con indicadores y puntaje', async ({ page }) => {
    await login(page, NEW_PASS);
    await page.getByRole('link', { name: /Resúmenes/ }).click();
    await expect(page.getByRole('tab', { name: 'Sanidad' })).toBeVisible();
    await expect(page.getByLabel('Puntaje')).toContainText('%');
    const items = page.getByRole('list', { name: 'Indicadores' }).getByRole('listitem');
    expect(await items.count()).toBeGreaterThanOrEqual(7);
    await expect(page.getByRole('list', { name: 'Indicadores' })).toContainText('Uso de tarjetas');
    await expect(page.getByRole('list', { name: 'Indicadores' })).toContainText('Prestado del ahorro sin reponer');
    await page.screenshot({ path: 'test-results/page-Sanidad.png', fullPage: true });
  });

  test('autorización OAuth: pantalla de consentimiento y revocación', async ({ page, request }) => {
    const reg = await request.post('/oauth/register', { data: { redirect_uris: ['http://localhost:9/cb'], client_name: 'Claude Code (e2e)' } });
    const client = await reg.json();
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    await page.context().clearCookies();
    const url = `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent('http://localhost:9/cb')}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&state=abc`;
    await page.goto(url);
    // sin sesión: va al login y, tras entrar, vuelve al consentimiento
    await expect(page).toHaveURL(/\/login\?next=/);
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Contraseña').fill(NEW_PASS);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByRole('heading', { name: /¿Autorizar a «Claude Code \(e2e\)»\?/ })).toBeVisible();
    await page.screenshot({ path: 'test-results/page-Autorizar.png' });
    await page.route('http://localhost:9/**', (route) => route.fulfill({ status: 200, body: 'ok' }));
    await page.getByRole('button', { name: 'Autorizar' }).click();
    await page.waitForURL(/localhost:9\/cb\?.*code=/);
    expect(page.url()).toContain('state=abc');
  });
});
