const { sleep } = require("./browser");

async function waitFor(page, predicate, timeoutMs = 20000, label = "condition", ...args) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await page.evaluate(predicate, ...args);
    if (ok) return true;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function ensureReviewPage(page, reviewUrl) {
  const currentUrl = await page.evaluate(() => location.href);
  if (!currentUrl.includes("/admin/transactions/txn-review")) {
    await page.navigate(reviewUrl);
  }

  await waitFor(page, () => document.readyState === "complete" || document.readyState === "interactive", 20000, "page load");
}

async function clickRefreshIfPresent(page) {
  await waitFor(page, () => Array.from(document.querySelectorAll("button"))
    .some((button) => /refresh/i.test(button.textContent || button.title || "")), 90000, "Refresh button");

  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const refresh = buttons.find((button) => /refresh/i.test(button.textContent || button.title || ""));
    if (!refresh) return false;
    refresh.scrollIntoView({ block: "center", inline: "center" });
    refresh.click();
    return true;
  });
  if (clicked) {
    await sleep(1500);
    await waitFor(page, () => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const refresh = buttons.find((button) => /refresh/i.test(button.textContent || button.title || ""));
      const rows = document.querySelectorAll("tbody tr");
      const pageText = String(document.body?.innerText || "");
      const stillLoading = /Loading(?:\.\.\.|\s)/i.test(pageText);
      return Boolean(refresh && !refresh.disabled && rows.length > 0 && !stillLoading);
    }, 90000, "review table after Refresh");
    await sleep(1000);
  }
  return clicked;
}

async function getCandidates(page, config) {
  return page.evaluate((allowedStatuses, requireGatewayMatch, enableWrongAmount, enableWrongPhone, enableManualApproval, enableBalanceMismatch, dateScope) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const amountToNumber = (value) => Number(String(value || "").replace(/,/g, ""));
    const parseUpdatedAt = (value) => {
      const parsed = Date.parse(clean(value));
      return Number.isFinite(parsed) ? new Date(parsed) : null;
    };
    const dateAllowed = (updatedText) => {
      const scope = dateScope || "all";
      if (scope === "all") return true;
      const updated = parseUpdatedAt(updatedText);
      if (!updated) return false;
      const now = new Date();
      if (scope === "today") {
        return updated.getFullYear() === now.getFullYear()
          && updated.getMonth() === now.getMonth()
          && updated.getDate() === now.getDate();
      }
      if (scope === "month") {
        return updated.getFullYear() === now.getFullYear()
          && updated.getMonth() === now.getMonth();
      }
      if (scope === "week") {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const day = start.getDay();
        start.setDate(start.getDate() - (day === 0 ? 6 : day - 1));
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(start.getDate() + 7);
        return updated >= start && updated < end;
      }
      return true;
    };
    const phoneDigits = (value) => clean(value).replace(/\D/g, "");
    const maskedPhoneMatches = (phone, mask) => {
      const left = phoneDigits(phone);
      const right = clean(mask).replace(/[^0-9Xx*]/g, "");
      if (!left || !right) return true;
      if (left.length !== right.length) return false;
      return Array.from(right).every((char, index) => /[Xx*]/.test(char) || char === left[index]);
    };
    const isFullPhone = (value) => /^\d{10,15}$/.test(phoneDigits(value));
    const agentKey = (value) => clean(value)
      .toUpperCase()
      .replace(/\s+/g, "")
      .replace(/\d+-M\d*$/i, "")
      .replace(/\d+$/g, "");
    const allowed = (allowedStatuses || []).map((status) => status.toLowerCase());

    return Array.from(document.querySelectorAll("tbody tr")).map((row, index) => {
      const cells = Array.from(row.children);
      if (cells.length < 9) return null;

      const ref = clean(cells[0].querySelector(".fw-semibold, div")?.textContent);
      const id = clean(cells[0].querySelector("small")?.textContent).replace(/^ID:\s*/i, "");
      const merchantName = clean(cells[1].querySelector("div")?.textContent);
      const walletText = clean(cells[1].querySelector("small")?.textContent);
      const agentName = clean(walletText.match(/\/\s*([^\s/]+)/)?.[1]);
      const gatewayTransactionId = clean(cells[2].querySelector("div")?.textContent);
      const tableAmountText = clean(cells[3].querySelector("div")?.textContent);
      const smsAmountText = clean(cells[3].querySelector("small")?.textContent);
      const customerPhone = clean(cells[4].querySelector("div")?.textContent);
      const smsPhoneText = clean(cells[4].querySelector("small")?.textContent);
      const smsPhoneRawMatch = smsPhoneText.match(/SMS:\s*([0-9Xx*]{6,20})/i);
      const smsPhoneRaw = smsPhoneRawMatch ? clean(smsPhoneRawMatch[1]) : "";
      const statusBadges = Array.from(cells[5].querySelectorAll(".badge"))
        .map((badge) => clean(badge.textContent))
        .filter(Boolean);
      const statusText = statusBadges.length ? statusBadges.join(", ") : clean(cells[5].textContent);
      const status = statusBadges[0] || statusText;
      const reasonBadge = clean(cells[6].querySelector(".badge")?.textContent);
      const reasonText = clean(cells[6].textContent);
      const updatedText = clean(cells[7]?.textContent);
      const updatedAt = parseUpdatedAt(updatedText)?.toISOString() || "";
      if (!dateAllowed(updatedText)) return null;

      const isWrongAmount = /wrong amount/i.test(`${reasonBadge} ${reasonText}`);
      const isWrongPhone = /wrong phone number/i.test(`${reasonBadge} ${reasonText}`);
      const isManualApproval = /manual approval required/i.test(`${reasonBadge} ${reasonText}`);
      const isBalanceMismatch = /balance mismatch/i.test(`${reasonBadge} ${reasonText}`);
      const tableAmountMatch = tableAmountText.match(/[\d,]+(?:\.\d+)?/);
      const tableAmount = amountToNumber(tableAmountMatch?.[0]);
      const transactionPhone = phoneDigits(customerPhone);
      const hasProcessedStatus = statusBadges.some((value) => /^Processed$/i.test(value)) || /\bProcessed\b/i.test(statusText);
      if (!ref) return null;
      if (hasProcessedStatus) {
        return {
          rowIndex: index,
          ref,
          id,
          merchantName,
          walletText,
          agentName,
          gatewayTransactionId,
          tableAmountText,
          customerPhone,
          status: statusText,
          statusBadges,
          reasonBadge,
          reasonText,
          updatedText,
          updatedAt,
          candidateType: "processed_status",
          cleanupOnly: true,
          cleanupReason: "Processed status",
          transactionAmount: tableAmount,
          apiStatementAmount: tableAmount,
          correctAmountText: Number.isFinite(tableAmount) ? String(tableAmount) : "",
          correctAmountSource: "Transaction",
          originalCustomerPhone: transactionPhone,
          correctCustomerPhone: transactionPhone,
          correctPhoneSource: "Customer Phone",
          phoneMatches: true,
          manualDataComplete: true,
          editButtonPresent: false
        };
      }
      if (isBalanceMismatch && enableBalanceMismatch) {
        const walletBalanceMatch = reasonText.match(/Wallet balance:\s*([\d,]+(?:\.\d+)?)/i);
        const currentBalanceMatch = reasonText.match(/SMS current balance:\s*([\d,]+(?:\.\d+)?)/i);
        const balancePhoneMismatch = Boolean(smsPhoneRaw && !maskedPhoneMatches(transactionPhone, smsPhoneRaw));
        const fullCorrectPhone = balancePhoneMismatch && isFullPhone(smsPhoneRaw) ? phoneDigits(smsPhoneRaw) : "";
        return {
          rowIndex: index,
          ref,
          id,
          merchantName,
          walletText,
          agentName,
          agentKey: agentKey(agentName),
          gatewayTransactionId,
          tableAmountText,
          customerPhone,
          status: statusText,
          statusBadges,
          reasonBadge,
          reasonText,
          updatedText,
          updatedAt,
          candidateType: "balance_mismatch",
          transactionAmount: tableAmount,
          apiStatementAmount: tableAmount,
          correctAmountText: Number.isFinite(tableAmount) ? String(tableAmount) : "",
          correctAmountSource: "Transaction",
          walletBalance: walletBalanceMatch ? amountToNumber(walletBalanceMatch[1]) : null,
          smsCurrentBalance: currentBalanceMatch ? amountToNumber(currentBalanceMatch[1]) : null,
          smsPhoneRaw,
          balanceMismatchPhoneIssue: balancePhoneMismatch,
          originalCustomerPhone: transactionPhone,
          correctCustomerPhone: fullCorrectPhone || transactionPhone,
          correctPhoneSource: balancePhoneMismatch ? (fullCorrectPhone ? "SMS" : "SMS masked") : "Customer Phone",
          phoneMatches: !balancePhoneMismatch,
          manualDataComplete: !balancePhoneMismatch || Boolean(fullCorrectPhone),
          editButtonPresent: false
        };
      }
      if (!ref || (!isWrongAmount && !isWrongPhone && !isManualApproval)) return null;
      if (isWrongAmount && !enableWrongAmount) return null;
      if (isWrongPhone && !enableWrongPhone) return null;
      if (isManualApproval && !enableManualApproval) return null;
      if (allowed.length && !allowed.includes(status.toLowerCase())) return null;
      if (!isManualApproval && requireGatewayMatch && !/GatewayTransactionId(?:\s+and\s+amount)?\s+matched/i.test(reasonText)) return null;

      const amountMatch = reasonText.match(/transaction amount\s+([\d,]+(?:\.\d+)?)\s+did not match\s+(API statement|SMS)\s+amount\s+([\d,]+(?:\.\d+)?)/i);
      const phoneMatch = reasonText.match(/transaction phone\s*['"]?(\d{10,15})['"]?\s+did not match\s+(API statement|SMS)\s+phone\s*['"]?(\d{10,15})['"]?/i);
      if (isWrongAmount && !amountMatch) return null;
      if (isWrongPhone && !phoneMatch) return null;

      const smsAmountMatch = smsAmountText.match(/SMS:\s*([\d,]+(?:\.\d+)?)/i);
      const smsPhoneMatch = smsPhoneText.match(/SMS:\s*(\d{10,15})/i);
      const smsAmount = smsAmountMatch ? amountToNumber(smsAmountMatch[1]) : NaN;
      const smsPhone = smsPhoneMatch ? clean(smsPhoneMatch[1]) : "";
      const transactionAmount = amountMatch ? amountToNumber(amountMatch[1]) : tableAmount;
      const correctAmount = amountMatch
        ? amountToNumber(amountMatch[3])
        : (isManualApproval && Number.isFinite(smsAmount) ? smsAmount : tableAmount);
      const originalCustomerPhone = phoneMatch ? clean(phoneMatch[1]) : transactionPhone;
      const correctCustomerPhone = phoneMatch
        ? clean(phoneMatch[3])
        : (isManualApproval ? smsPhone : transactionPhone);

      const editButton = cells[8].querySelector('button[title*="Edit"], button.btn-outline-warning');
      return {
        rowIndex: index,
        ref,
        id,
        merchantName,
        walletText,
        agentName,
        agentKey: agentKey(agentName),
        gatewayTransactionId,
        tableAmountText,
        customerPhone,
        status: statusText,
        statusBadges,
        reasonBadge,
        reasonText,
        updatedText,
        updatedAt,
        candidateType: isManualApproval ? "manual_approval" : (isWrongPhone ? "wrong_phone" : "wrong_amount"),
        transactionAmount,
        apiStatementAmount: correctAmount,
        correctAmountText: String(correctAmount),
        correctAmountSource: amountMatch ? clean(amountMatch[2]) : (isManualApproval ? (Number.isFinite(smsAmount) ? "SMS" : "Unavailable") : "Transaction"),
        originalCustomerPhone,
        correctCustomerPhone,
        correctPhoneSource: phoneMatch ? clean(phoneMatch[2]) : (isManualApproval ? (smsPhone ? "SMS" : "Unavailable") : "Customer Phone"),
        phoneMatches: isManualApproval ? Boolean(transactionPhone && smsPhone && transactionPhone === smsPhone) : true,
        manualDataComplete: isManualApproval ? Boolean(Number.isFinite(smsAmount) && smsPhone) : true,
        editButtonPresent: Boolean(editButton)
      };
    }).filter(Boolean);
  }, config.allowedStatuses, config.requireGatewayMatch, config.enableWrongAmount, config.enableWrongPhone, config.enableManualApproval, config.enableBalanceMismatch, config.dateScope);
}

async function openEditModal(page, ref) {
  await closeModalIfOpen(page);
  await waitFor(page, () => {
    const editModal = Array.from(document.querySelectorAll(".modal-content")).find((item) => /Edit Transaction/i.test(item.textContent || ""));
    return !editModal;
  }, 10000, "old edit modal to close");

  const found = await page.evaluate((targetRef) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const rows = Array.from(document.querySelectorAll("tbody tr"));
    const row = rows.find((candidate) => clean(candidate.children[0]?.querySelector(".fw-semibold, div")?.textContent) === targetRef);
    if (!row) return false;
    const actionCell = row.children[8];
    const edit = actionCell.querySelector('button[title*="Edit"], button.btn-outline-warning');
    if (!edit) return false;
    edit.scrollIntoView({ block: "center", inline: "center" });
    return true;
  }, ref);

  if (!found) throw new Error(`Could not find edit button for ${ref}`);
  await sleep(600);
  await page.send("Page.bringToFront");
  const editTarget = await page.evaluate((targetRef) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const rows = Array.from(document.querySelectorAll("tbody tr"));
    const row = rows.find((candidate) => clean(candidate.children[0]?.querySelector(".fw-semibold, div")?.textContent) === targetRef);
    const edit = row?.children[8]?.querySelector('button[title*="Edit"], button.btn-outline-warning');
    if (!edit) return null;
    const rect = edit.getBoundingClientRect();
    return {
      x: rect.left + (rect.width / 2),
      y: rect.top + (rect.height / 2),
      elementAtPoint: document.elementFromPoint(rect.left + (rect.width / 2), rect.top + (rect.height / 2))?.closest("button") === edit
    };
  }, ref);

  if (!editTarget || !editTarget.elementAtPoint) throw new Error(`Edit button for ${ref} is covered by another element`);
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: editTarget.x,
    y: editTarget.y
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: editTarget.x,
    y: editTarget.y,
    button: "left",
    clickCount: 1
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: editTarget.x,
    y: editTarget.y,
    button: "left",
    clickCount: 1
  });
  await waitFor(page, (targetRef) => {
    const modal = Array.from(document.querySelectorAll(".modal-content")).find((item) => /Edit Transaction/i.test(item.textContent || ""));
    if (!modal) return false;
    return String(modal.textContent || "").includes(targetRef);
  }, 8000, `edit modal for ${ref}`, ref);

  await waitFor(page, () => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const modal = Array.from(document.querySelectorAll(".modal-content")).find((item) => /Edit Transaction/i.test(item.textContent || ""));
    if (!modal) return false;
    const selects = Array.from(modal.querySelectorAll("select"));
    const merchantSelect = selects.find((select) => {
      const firstOptions = Array.from(select.options).slice(0, 30).map((option) => clean(option.textContent)).join(" | ");
      return /Select a merchant/i.test(firstOptions)
        || /\bB1\b.*Agent/i.test(firstOptions)
        || /\bM1\b.*Personal/i.test(firstOptions)
        || /\bJ1\b.*Agent/i.test(firstOptions);
    });
    return Boolean(
      merchantSelect
      && modal.querySelector("#correctCustomerPhone")
      && Array.from(modal.querySelectorAll("button")).some((button) => /make up deposit/i.test(button.textContent || ""))
    );
  }, 20000, `edit modal fields for ${ref}`);
}

async function getDuplicateCreditBlock(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const modal = Array.from(document.querySelectorAll(".modal-content")).reverse().find((node) => /Edit Transaction/i.test(node.textContent || ""));
    if (!modal) return { blocked: false };

    const message = clean(modal.textContent);
    const blocked = /Gateway\s*Transaction\s*Id/i.test(message)
      && /already used by transaction\s*Id/i.test(message)
      && /Make up deposit blocked/i.test(message)
      && /prevent double credit/i.test(message);
    if (!blocked) return { blocked: false };

    const gatewayMatch = message.match(/Gateway\s*Transaction\s*Id\s+([^\s]+)\s+is already used/i);
    const transactionMatch = message.match(/already used by transaction\s*Id:\s*(\d+)/i);
    const referenceMatch = message.match(/Reference:\s*([A-Z0-9]+)/i);
    return {
      blocked: true,
      message,
      ref: referenceMatch ? referenceMatch[1] : "",
      gatewayTransactionId: gatewayMatch ? gatewayMatch[1] : "",
      usedByTransactionId: transactionMatch ? transactionMatch[1] : ""
    };
  });
}

async function waitForDuplicateCreditBlock(page, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const outcome = await getDuplicateCreditBlock(page);
    if (outcome.blocked) return outcome;

    const modalOpen = await page.evaluate(() => Array.from(document.querySelectorAll(".modal-content"))
      .some((node) => /Edit Transaction/i.test(node.textContent || "")));
    if (!modalOpen) return { blocked: false, modalClosed: true };
    await sleep(250);
  }
  return getDuplicateCreditBlock(page);
}

async function fillAndMaybeSubmitModal(page, candidate, dryRun) {
  return page.evaluate(async (item, isDryRun) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const modal = Array.from(document.querySelectorAll(".modal-content")).reverse().find((node) => /Edit Transaction/i.test(node.textContent || ""));
    if (!modal) throw new Error("Edit modal is not open");

    const labels = Array.from(modal.querySelectorAll("label"));
    const labelText = (label) => clean(label.textContent).replace(/\*/g, "").trim();
    const findByLabel = (text, selector) => {
      const target = text.toLowerCase();
      const matches = labels.filter((label) => {
        const value = labelText(label).toLowerCase();
        return value === target || value.includes(target);
      });
      for (const label of matches) {
        if (label.htmlFor) {
          const byId = modal.querySelector(`#${CSS.escape(label.htmlFor)}`);
          if (byId && byId.matches(selector)) return byId;
        }
        const container = label.closest(".col-md-6, .col-md-8, .col-md-12, .row") || label.parentElement || modal;
        const field = container.querySelector(selector);
        if (field) return field;
        let sibling = label.nextElementSibling;
        while (sibling) {
          if (sibling.matches && sibling.matches(selector)) return sibling;
          const nested = sibling.querySelector && sibling.querySelector(selector);
          if (nested) return nested;
          sibling = sibling.nextElementSibling;
        }
      }
      return null;
    };

    const setValue = (field, value) => {
      const proto = field.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      descriptor.set.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    };

    const normalizeMerchant = (value) => clean(value)
      .replace(/\([^)]*\)/g, "")
      .replace(/\s*-\s*/g, " - ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

    const amountInput = findByLabel("Amount", "input");
    const gatewayInput = findByLabel("Gateway Transaction ID", "input");
    const customerPhoneInput = findByLabel("Customer Phone", "input");
    const merchantSelect = findByLabel("Merchant", "select")
      || Array.from(modal.querySelectorAll("select")).find((select) => {
        const optionsText = Array.from(select.options).map((option) => clean(option.textContent)).join(" | ");
        return /Select a merchant/i.test(optionsText)
          || /\bB1\b.*Agent/i.test(optionsText)
          || /\bM1\b.*Personal/i.test(optionsText)
          || /\bJ1\b.*Agent/i.test(optionsText);
      });
    const correctCustomerPhone = modal.querySelector("#correctCustomerPhone");
    const makeUpButton = Array.from(modal.querySelectorAll("button")).find((button) => /make up deposit/i.test(button.textContent || ""));

    if (!amountInput) throw new Error("Amount input was not found");
    if (!gatewayInput) throw new Error("Gateway Transaction ID input was not found");
    if (!customerPhoneInput) throw new Error("Customer Phone input was not found");
    if (!merchantSelect) throw new Error("Merchant select was not found");
    if (!correctCustomerPhone) throw new Error("Correct Customer Phone input was not found");
    if (!makeUpButton) throw new Error("Make up deposit button was not found");

    const modalGateway = clean(gatewayInput.value);
    if (item.gatewayTransactionId && modalGateway && modalGateway !== item.gatewayTransactionId) {
      throw new Error(`Gateway mismatch. Table has ${item.gatewayTransactionId}, modal has ${modalGateway}`);
    }

    const merchantTarget = normalizeMerchant(item.merchantName);
    const options = Array.from(merchantSelect.options);
    const selected = options.find((option) => normalizeMerchant(option.textContent) === merchantTarget)
      || options.find((option) => normalizeMerchant(option.textContent).startsWith(merchantTarget));
    if (!selected) {
      throw new Error(`Could not match merchant option for ${item.merchantName}`);
    }

    const originalPhone = clean(customerPhoneInput.value || item.customerPhone);
    const phone = clean(item.correctCustomerPhone || originalPhone);
    setValue(amountInput, item.correctAmountText);
    setValue(merchantSelect, selected.value);
    setValue(correctCustomerPhone, phone);

    const result = {
      ref: item.ref,
      originalAmount: item.transactionAmount,
      correctedAmount: item.apiStatementAmount,
      customerPhone: phone,
      originalCustomerPhone: originalPhone,
      correctCustomerPhone: phone,
      candidateType: item.candidateType,
      merchantName: item.merchantName,
      merchantOption: clean(selected.textContent),
      gatewayTransactionId: modalGateway,
      dryRun: isDryRun
    };

    const waitForClickableMakeUp = () => new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const currentButton = Array.from(modal.querySelectorAll("button")).find((button) => /make up deposit/i.test(button.textContent || ""));
        const modalText = clean(modal.textContent);
        const isLoadingWallets = /Loading available wallets/i.test(modalText);
        const disabled = !currentButton || currentButton.disabled || currentButton.getAttribute("aria-disabled") === "true";
        if (currentButton && !disabled && !isLoadingWallets) {
          clearInterval(timer);
          resolve(currentButton);
          return;
        }
        if (Date.now() - start > 30000) {
          clearInterval(timer);
          reject(new Error("Make up deposit button was not ready after wallet loading"));
        }
      }, 250);
    });

    if (!isDryRun) {
      const readyButton = await waitForClickableMakeUp();
      result.buttonReadyBeforeClick = true;
      readyButton.click();
      result.submitted = true;
    } else {
      result.submitted = false;
    }
    return result;
  }, candidate, dryRun);
}

async function invokeRowAction(page, ref, titleText) {
  return page.evaluate((targetRef, targetTitle) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const row = Array.from(document.querySelectorAll("tbody tr"))
      .find((candidate) => clean(candidate.children[0]?.querySelector(".fw-semibold, div")?.textContent) === targetRef);
    const button = Array.from(row?.children[8]?.querySelectorAll("button") || [])
      .find((item) => clean(item.title).toLowerCase().includes(targetTitle.toLowerCase()));
    if (!button) return false;
    const propsKey = Object.keys(button).find((key) => key.startsWith("__reactProps$"));
    const handler = propsKey ? button[propsKey]?.onClick : null;
    if (typeof handler === "function") handler();
    else button.click();
    return true;
  }, ref, titleText);
}

async function searchReviewList(page, query) {
  const changed = await page.evaluate((searchText) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const inputs = Array.from(document.querySelectorAll("input"));
    const search = inputs.find((input) => /Search ref/i.test(input.placeholder || ""))
      || inputs.find((input) => /ref|trx|id|phone/i.test(input.placeholder || ""));
    if (!search) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(search, clean(searchText));
    search.dispatchEvent(new Event("input", { bubbles: true }));
    search.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, query);
  if (changed) await sleep(1500);
  return changed;
}

async function approveReviewTransaction(page, ref) {
  await closeModalIfOpen(page);
  let clicked = await clickApproveButton(page, ref);
  if (!clicked.clicked) {
    await searchReviewList(page, ref);
    clicked = await clickApproveButton(page, ref);
  }
  if (!clicked.clicked) {
    throw new Error(`Could not approve ${ref}: ${clicked.reason}`);
  }
  await sleep(1500);
  return {
    ref,
    approvedFromReviewList: true
  };
}

async function clickApproveButton(page, ref) {
  return page.evaluate((targetRef) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const rows = Array.from(document.querySelectorAll("tbody tr"));
    const row = rows.find((candidate) => clean(candidate.children[0]?.querySelector(".fw-semibold, div")?.textContent) === targetRef);
    if (!row) return { clicked: false, reason: "row not found" };

    const actionCell = row.children[8];
    if (!actionCell) return { clicked: false, reason: "action cell not found" };
    const buttons = Array.from(actionCell.querySelectorAll("button"));
    const approve = buttons.find((button) => /Approve|Accept/i.test(button.title || ""))
      || buttons.find((button) => /Approve|Accept/i.test(clean(button.textContent)))
      || buttons.find((button) => button.className.includes("btn-success"))
      || buttons.find((button) => {
        const style = getComputedStyle(button);
        return /rgb\(25,\s*135,\s*84\)|rgb\(20,\s*184,\s*120\)|rgb\(18,\s*183,\s*106\)/i.test(style.backgroundColor);
      });
    if (!approve) return { clicked: false, reason: "approve button not found" };
    approve.scrollIntoView({ block: "center", inline: "center" });
    const propsKey = Object.keys(approve).find((key) => key.startsWith("__reactProps$"));
    const handler = propsKey ? approve[propsKey]?.onClick : null;
    if (typeof handler === "function") handler();
    else approve.click();
    return { clicked: true, reason: "clicked" };
  }, ref);
}

async function getVendorIdFromDetails(page, ref) {
  await closeModalIfOpen(page);
  const opened = await invokeRowAction(page, ref, "View details");
  if (!opened) throw new Error(`Could not find View details for ${ref}`);
  await waitFor(page, (targetRef) => {
    const modal = Array.from(document.querySelectorAll(".modal-content"))
      .find((node) => /Transaction Details/i.test(node.textContent || ""));
    return Boolean(modal && String(modal.textContent || "").includes(targetRef));
  }, 10000, `transaction details for ${ref}`, ref);

  const vendorId = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const modal = Array.from(document.querySelectorAll(".modal-content"))
      .find((node) => /Transaction Details/i.test(node.textContent || ""));
    const row = Array.from(modal?.querySelectorAll(".detail-row") || [])
      .find((item) => /^Vendor ID:/i.test(clean(item.textContent)));
    return clean(row?.textContent).replace(/^Vendor ID:\s*/i, "");
  });
  await closeModalIfOpen(page);
  if (!vendorId || /^N\/?A$/i.test(vendorId)) {
    throw new Error(`Verified Vendor ID was not available for ${ref}`);
  }
  return vendorId;
}

async function fillAndMaybeResolveAmountMismatch(page, candidate, dryRun) {
  const vendorId = await getVendorIdFromDetails(page, candidate.ref);
  const opened = await invokeRowAction(page, candidate.ref, "Resolve amount mismatch");
  if (!opened) throw new Error(`Could not find Resolve amount mismatch for ${candidate.ref}`);
  await waitFor(page, (targetRef) => {
    const modal = Array.from(document.querySelectorAll(".modal-content"))
      .find((node) => /Resolve Amount Mismatch/i.test(node.textContent || ""));
    return Boolean(modal && String(modal.textContent || "").includes(targetRef));
  }, 10000, `amount resolver for ${candidate.ref}`, candidate.ref);

  const result = await page.evaluate(async (item, verifiedVendorId, isDryRun) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const modal = Array.from(document.querySelectorAll(".modal-content"))
      .find((node) => /Resolve Amount Mismatch/i.test(node.textContent || ""));
    if (!modal) throw new Error("Resolve Amount Mismatch modal is not open");
    const inputs = Array.from(modal.querySelectorAll("input"));
    const amountInput = inputs.find((input) => input.type === "number");
    const labels = Array.from(modal.querySelectorAll("label"));
    const vendorLabel = labels.find((label) => /^Vendor ID/i.test(clean(label.textContent)));
    const vendorInput = (vendorLabel?.htmlFor && modal.querySelector(`#${CSS.escape(vendorLabel.htmlFor)}`))
      || vendorLabel?.parentElement?.querySelector("input")
      || inputs.find((input) => /vendor|invoice number/i.test(input.placeholder || ""));
    const gatewayInput = inputs.find((input) => /gateway transaction ID/i.test(input.placeholder || ""));
    const resolveButton = Array.from(modal.querySelectorAll("button"))
      .find((button) => /Resolve Mismatch/i.test(button.textContent || ""));
    if (!amountInput || !vendorInput || !gatewayInput || !resolveButton) {
      throw new Error("Amount resolver fields were incomplete");
    }
    if (item.gatewayTransactionId && clean(gatewayInput.value) !== item.gatewayTransactionId) {
      throw new Error(`Gateway mismatch. Table has ${item.gatewayTransactionId}, resolver has ${clean(gatewayInput.value)}`);
    }
    const setValue = (field, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    };
    setValue(amountInput, item.correctAmountText);
    setValue(vendorInput, verifiedVendorId);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const readyButton = Array.from(modal.querySelectorAll("button"))
      .find((button) => /Resolve Mismatch/i.test(button.textContent || ""));
    if (!readyButton || readyButton.disabled || readyButton.getAttribute("aria-disabled") === "true") {
      throw new Error("Resolve Mismatch button was not ready after field validation");
    }
    if (!isDryRun) readyButton.click();
    return {
      ref: item.ref,
      originalAmount: item.transactionAmount,
      correctedAmount: item.apiStatementAmount,
      gatewayTransactionId: clean(gatewayInput.value),
      vendorId: verifiedVendorId,
      candidateType: item.candidateType,
      resolutionMode: "amount_resolver",
      dryRun: isDryRun,
      submitted: !isDryRun
    };
  }, candidate, vendorId, dryRun);

  if (dryRun) return result;
  const start = Date.now();
  while (Date.now() - start < 30000) {
    const state = await page.evaluate(() => {
      const modal = Array.from(document.querySelectorAll(".modal-content"))
        .find((node) => /Resolve Amount Mismatch/i.test(node.textContent || ""));
      if (!modal) return { open: false, error: "" };
      const alert = Array.from(modal.querySelectorAll(".alert-danger, [role='alert']"))
        .map((node) => String(node.textContent || "").replace(/\s+/g, " ").trim())
        .find((text) => /failed|error|already used|blocked/i.test(text));
      return { open: true, error: alert || "" };
    });
    if (state.error) throw new Error(state.error);
    if (!state.open) return result;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for amount resolver submission for ${candidate.ref}`);
}

async function closeModalIfOpen(page) {
  const clicked = await page.evaluate(() => {
    const modal = Array.from(document.querySelectorAll(".modal-content")).reverse()
      .find((node) => /Edit Transaction|Resolve Amount Mismatch|Transaction Details/i.test(node.textContent || ""));
    if (!modal) return false;
    const close = modal.querySelector('button[aria-label="Close"]')
      || Array.from(modal.querySelectorAll("button")).find((button) => /cancel/i.test(button.textContent || ""));
    if (!close) return false;
    close.click();
    return true;
  });
  if (clicked) {
    await waitFor(page, () => {
      const modal = Array.from(document.querySelectorAll(".modal-content"))
        .find((node) => /Edit Transaction|Resolve Amount Mismatch|Transaction Details/i.test(node.textContent || ""));
      return !modal;
    }, 10000, "action modal to close").catch(() => {});
  }
  return clicked;
}

async function removeFromReviewList(page, ref) {
  await closeModalIfOpen(page);
  let clicked = await clickRemoveButton(page, ref);
  if (!clicked.clicked && clicked.reason === "row not found") {
    await searchReviewList(page, ref);
    clicked = await clickRemoveButton(page, ref);
  }

  if (!clicked.clicked) {
    throw new Error(`Could not remove ${ref} from review list: ${clicked.reason}`);
  }

  await waitFor(page, (targetRef) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const rows = Array.from(document.querySelectorAll("tbody tr"));
    return !rows.some((row) => clean(row.children[0]?.querySelector(".fw-semibold, div")?.textContent) === targetRef);
  }, 15000, `review row removal for ${ref}`, ref);

  return {
    ref,
    removedFromReviewList: true
  };
}

async function clickRemoveButton(page, ref) {
  return page.evaluate((targetRef) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const rows = Array.from(document.querySelectorAll("tbody tr"));
    const row = rows.find((candidate) => clean(candidate.children[0]?.querySelector(".fw-semibold, div")?.textContent) === targetRef);
    if (!row) return { clicked: false, reason: "row not found" };

    const actionCell = row.children[8];
    if (!actionCell) return { clicked: false, reason: "action cell not found" };

    const buttons = Array.from(actionCell.querySelectorAll("button"));
    const remove = buttons.find((button) => /Remove from review list/i.test(button.title || ""))
      || buttons.find((button) => /Remove/i.test(button.title || ""))
      || buttons.find((button) => Array.from(button.querySelectorAll("path")).some((path) => {
        const pathData = String(path.getAttribute("d") || "").replace(/\s+/g, "");
        return pathData.includes("M168216h32v200") || pathData.includes("M96472");
      }))
      || buttons.reverse().find((button) => {
        const text = clean(button.textContent);
        return button.className.includes("btn-outline-danger") && !/amount/i.test(text);
      });

    if (!remove) return { clicked: false, reason: "remove button not found" };
    remove.scrollIntoView({ block: "center", inline: "center" });
    remove.click();
    return { clicked: true, reason: "clicked" };
  }, ref);
}

module.exports = {
  waitFor,
  ensureReviewPage,
  clickRefreshIfPresent,
  getCandidates,
  openEditModal,
  getDuplicateCreditBlock,
  waitForDuplicateCreditBlock,
  fillAndMaybeSubmitModal,
  fillAndMaybeResolveAmountMismatch,
  approveReviewTransaction,
  searchReviewList,
  closeModalIfOpen,
  removeFromReviewList
};
