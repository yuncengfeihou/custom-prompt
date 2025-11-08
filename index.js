// index.js (Custom Prompt Injector Plugin)
// Based on the 'star' (Favorites) plugin framework.
// This version is refactored to manage and inject per-chat custom prompts.

// --- SillyTavern Core Imports ---
import {
    eventSource,
    event_types,
    chat,
    getRequestHeaders,
    saveSettingsDebounced,
} from '../../../../script.js';
import {
    getContext,
    renderExtensionTemplateAsync,
    extension_settings,
    saveMetadataDebounced,
} from '../../../extensions.js';
import {
    POPUP_TYPE,
    callGenericPopup,
} from '../../../popup.js';

// =================================================================
//                      PLUGIN CONSTANTS & CONFIG
// =================================================================
const pluginName = 'custom-prompt';
const METADATA_KEY = 'custom_prompt_injector_data'; // Unique key for storing data in chat metadata

// --- UI Constants ---
const MODAL_ID = 'promptInjectorModal';
const MODAL_CLASS_NAME = 'prompt-injector-modal-dialog';
const MODAL_HEADER_CLASS = 'prompt-injector-modal-header';
const MODAL_TITLE_CLASS = 'prompt-injector-modal-title';
const MODAL_CLOSE_X_CLASS = 'prompt-injector-modal-close-x';
const MODAL_BODY_CLASS = 'prompt-injector-modal-body';
const SIDEBAR_TOGGLE_CLASS = 'prompt-injector-sidebar-toggle';
const SIDEBAR_TOGGLE_ID = 'prompt-injector-avatar-toggle';

// =================================================================
//                      PLUGIN STATE & REFERENCES
// =================================================================
let modalElement = null;
let modalDialogElement = null;
let modalTitleElement = null;
let modalBodyElement = null;

let currentViewingChatFile = null;      // Tracks which chat's prompt is being viewed/edited
let allChatsPromptData = [];            // Cache for all chats and their prompt data
let chatListScrollTop = 0;
let isLoadingOtherChats = false;

// =================================================================
//                      THEME MANAGEMENT
// =================================================================
/**
 * Applies the saved theme from localStorage when the modal opens.
 */
function applySavedTheme() {
    // This plugin will respect the theme set by the main 'star' plugin if present.
    const savedTheme = localStorage.getItem('favorites-theme');
    const isDark = savedTheme === 'dark';
    if (modalDialogElement) {
        modalDialogElement.classList.toggle('dark-theme', isDark);
    }
}

// =================================================================
//                      CORE ENGINE: PROMPT INJECTION
// =================================================================

/**
 * The core engine of the plugin. It reads the current chat's metadata
 * and injects the custom prompt, or clears it if none is found.
 * This MUST be called on every chat change.
 */
function applyOrClearCustomPrompt() {
    try {
        const context = getContext();
        if (!context || !context.chatMetadata) return;

        const promptData = context.chatMetadata[METADATA_KEY];
        const promptValue = promptData?.prompt || '';

        // The key for setExtensionPrompt must be unique and consistent for our plugin.
        const injectionKey = 'custom_prompt_injector_main';

        if (promptValue.trim() !== '') {
            context.setExtensionPrompt(
                injectionKey,
                promptValue,
                context.eventTypes.IN_CHAT,   // Position: In the chat history
                9999,                         // Depth: Very early in the history
                false,                        // Scan: No need for WI scan
                context.eventTypes.SYSTEM     // Role: System message
            );
            console.log(`[${pluginName}] Injected prompt for chat: ${context.chatId}`);
        } else {
            // CRITICAL: If there's no prompt, we must clear any existing injection
            // from a previously viewed chat by sending an empty string.
            context.setExtensionPrompt(
                injectionKey,
                '', // Empty value clears the injection
                context.eventTypes.IN_CHAT,
                9999,
                false,
                context.eventTypes.SYSTEM
            );
        }
    } catch (error) {
        console.error(`[${pluginName}] Error applying custom prompt:`, error);
    }
}


// =================================================================
//                      UI MODAL FUNCTIONS
// =================================================================

function ensureModalStructure() {
    if (modalElement) return;

    modalElement = document.createElement('div');
    modalElement.id = MODAL_ID;
    modalElement.innerHTML = `
        <div class="${MODAL_CLASS_NAME}">
            <div class="${MODAL_HEADER_CLASS}">
                <img id="${SIDEBAR_TOGGLE_ID}" class="${SIDEBAR_TOGGLE_CLASS}" src="img/ai4.png" title="切换侧边栏">
                <h3 class="${MODAL_TITLE_CLASS}">自定义提示词</h3>
                <div class="${MODAL_CLOSE_X_CLASS}"><i class="fa-solid fa-xmark"></i></div>
            </div>
            <div class="${MODAL_BODY_CLASS}"></div>
        </div>
    `;
    document.body.appendChild(modalElement);

    modalDialogElement = modalElement.querySelector(`.${MODAL_CLASS_NAME}`);
    modalTitleElement = modalElement.querySelector(`.${MODAL_TITLE_CLASS}`);
    modalBodyElement = modalElement.querySelector(`.${MODAL_BODY_CLASS}`);

    // --- Event Listeners ---
    modalElement.querySelector(`.${MODAL_CLOSE_X_CLASS}`).addEventListener('click', closePromptModal);
    modalElement.querySelector(`.${SIDEBAR_TOGGLE_CLASS}`).addEventListener('click', () => {
        modalDialogElement.classList.toggle('sidebar-closed');
    });
    modalElement.addEventListener('click', (e) => {
        if (e.target === modalElement) {
            closePromptModal();
        }
    });

    modalBodyElement.addEventListener('click', handleModalClick);
}

function centerModal() {
    if (!modalDialogElement) return;
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    const dialogWidth = modalDialogElement.offsetWidth;
    const dialogHeight = modalDialogElement.offsetHeight;
    modalDialogElement.style.left = `${Math.max(0, (windowWidth - dialogWidth) / 2)}px`;
    modalDialogElement.style.top = `${Math.max(0, (windowHeight - dialogHeight) / 2)}px`;
}

async function openPromptModal() {
    ensureModalStructure();
    applySavedTheme();

    const context = getContext();
    let avatarSrc = 'img/ai4.png';
    if (context.characterId !== undefined && context.characters && context.characters[context.characterId]) {
        const characterAvatar = context.characters[context.characterId].avatar;
        if (characterAvatar && characterAvatar !== 'multichar_dummy.png') {
            avatarSrc = `characters/${characterAvatar}`;
        }
    } else if (context.groupId) {
         const group = context.groups.find(g => g.id === context.groupId);
         if (group && group.avatar && group.avatar !== 'multichar_dummy.png') {
             avatarSrc = `groups/${group.avatar}`;
         }
    }
    const avatarToggle = modalElement.querySelector(`#${SIDEBAR_TOGGLE_ID}`);
    if (avatarToggle) avatarToggle.src = avatarSrc;

    modalElement.style.display = 'block';
    centerModal();
    
    // --- Performance Optimization ---
    currentPage = 1;
    currentViewingChatFile = null;
    allChatsPromptData = [];
    isLoadingOtherChats = false;
    modalBodyElement.innerHTML = '<div class="spinner"></div>';
    modalDialogElement.classList.add('sidebar-closed');
    
    // Immediately render the current chat's prompt editor
    await renderPromptView();

    // Silently load other chats in the background
    loadOtherChatsInBackground();
    
    requestAnimationFrame(() => {
        modalDialogElement.classList.add('visible');
    });

    window.addEventListener('resize', centerModal);
    document.addEventListener('keydown', handleEscKey);
}

function closePromptModal() {
    if (modalElement) {
        modalElement.style.display = 'none';
        if (modalDialogElement) {
            modalDialogElement.classList.remove('visible');
        }
    }
    window.removeEventListener('resize', centerModal);
    document.removeEventListener('keydown', handleEscKey);
}

function handleEscKey(event) {
    if (event.key === 'Escape') {
        closePromptModal();
    }
}

// =================================================================
//                      UI RENDERING
// =================================================================

async function renderPromptView(selectedChatFileName = null) {
    const context = getContext();
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');
    const selectedChatFileNameNoExt = selectedChatFileName ? String(selectedChatFileName).replace('.jsonl', '') : null;

    if (allChatsPromptData.length === 0) {
        const currentChatMetadata = context.chatMetadata || {};
        const initialData = {
            fileName: currentContextChatIdNoExt,
            displayName: currentContextChatIdNoExt,
            metadata: currentChatMetadata,
            messages: context.chat || [],
            isGroup: !!context.groupId,
            characterId: context.characterId,
            groupId: context.groupId,
        };
        allChatsPromptData.push(initialData);
        currentViewingChatFile = currentContextChatIdNoExt;
    } else if (selectedChatFileNameNoExt) {
        currentViewingChatFile = selectedChatFileNameNoExt;
    } else {
        currentViewingChatFile = currentContextChatIdNoExt;
    }

    let viewingChatData = allChatsPromptData.find(chatData => String(chatData.fileName).replace('.jsonl', '') === currentViewingChatFile);
    
    if (!viewingChatData && !isLoadingOtherChats) {
        modalBodyElement.innerHTML = '<div class="spinner"></div>';
        const fullChatData = await getFullChatData(context.characterId, context.groupId, currentViewingChatFile, !!context.groupId);
        if(fullChatData) {
            viewingChatData = {
                fileName: currentViewingChatFile,
                displayName: currentViewingChatFile,
                ...fullChatData,
                isGroup: !!context.groupId,
                characterId: context.characterId,
                groupId: context.groupId,
            };
            allChatsPromptData.push(viewingChatData);
        }
    } else if (!viewingChatData) {
        modalBodyElement.innerHTML = `<div class="prompt-empty">聊天数据正在加载中...</div>`;
        return;
    }

    const roleName = viewingChatData.isGroup
        ? (context.groups?.find(g => g.id === viewingChatData.groupId)?.name || '未命名群聊')
        : (context.characters[viewingChatData.characterId]?.name || context.name2);
    modalTitleElement.textContent = roleName || '自定义提示词';

    renderChatListPanel();
    renderPromptEditor(viewingChatData);
}

function renderChatListPanel() {
    let panel = modalBodyElement.querySelector('.prompt-chat-list-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.className = 'prompt-chat-list-panel';
        modalBodyElement.prepend(panel);
    }
    
    const context = getContext();
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');

    const chatListItemsHtml = `
        <div class="prompt-chat-list-items">
            ${allChatsPromptData.map(chat => {
                const fileNameNoExt = String(chat.fileName).replace('.jsonl', '');
                const hasPrompt = chat.metadata[METADATA_KEY]?.prompt;
                if (!hasPrompt && fileNameNoExt !== currentContextChatIdNoExt) return '';
                
                const isSelected = fileNameNoExt === currentViewingChatFile;
                return `
                    <div class="prompt-chat-list-item ${isSelected ? 'active' : ''}" data-chat-file="${fileNameNoExt}">
                        <div class="chat-list-item-name" title="${chat.displayName || fileNameNoExt}">
                            ${chat.displayName || fileNameNoExt}
                        </div>
                        <div class="chat-list-item-indicator">${hasPrompt ? '✓' : ''}</div>
                    </div>
                `;
            }).join('')}
            ${isLoadingOtherChats ? '<div class="chat-list-loader">加载中...</div>' : ''}
        </div>
    `;
    panel.innerHTML = chatListItemsHtml;
    
    const chatListElement = panel.querySelector('.prompt-chat-list-items');
    if (chatListElement) chatListElement.scrollTop = chatListScrollTop;
}

function renderPromptEditor(viewingChatData) {
    let mainPanel = modalBodyElement.querySelector('.prompt-main-panel');
    if (!mainPanel) {
        mainPanel = document.createElement('div');
        mainPanel.className = 'prompt-main-panel';
        modalBodyElement.appendChild(mainPanel);
    }
    
    const promptData = viewingChatData.metadata[METADATA_KEY];
    const currentPrompt = promptData?.prompt || '';

    const mainPanelHtml = `
        <div class="prompt-editor-container">
            <p class="prompt-editor-info">此提示词将在每次生成时作为一条系统消息 (System Role) 注入到聊天记录的极早期位置 (Depth @D 9999)。</p>
            <textarea id="custom-prompt-textarea" class="text_pole" placeholder="在此输入你的自定义提示词...">${currentPrompt}</textarea>
            <button id="save-custom-prompt-button" class="menu_button primary_button">保存提示词</button>
        </div>
    `;

    mainPanel.innerHTML = mainPanelHtml;

    // Add event listener for the save button
    mainPanel.querySelector('#save-custom-prompt-button').addEventListener('click', handleSavePrompt);
}

async function loadOtherChatsInBackground() {
    if (isLoadingOtherChats) return;
    isLoadingOtherChats = true;
    renderChatListPanel();

    const otherChatsData = await getAllChatDataForCurrentContext(true); // pass true to skip current chat
    
    const existingFileNames = new Set(allChatsPromptData.map(c => c.fileName));
    otherChatsData.forEach(chatData => {
        if (!existingFileNames.has(chatData.fileName)) {
            allChatsPromptData.push(chatData);
        }
    });

    const context = getContext();
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');
    allChatsPromptData.sort((a, b) => {
        if (a.fileName === currentContextChatIdNoExt) return -1;
        if (b.fileName === currentContextChatIdNoExt) return 1;
        return a.fileName.localeCompare(b.fileName);
    });

    isLoadingOtherChats = false;
    renderChatListPanel();
}

// =================================================================
//                   MODAL EVENT HANDLER & SAVE LOGIC
// =================================================================

async function handleModalClick(event) {
    const target = event.target;
    const chatListItem = target.closest('.prompt-chat-list-item');
    if (chatListItem) {
        const chatFile = String(chatListItem.dataset.chatFile).replace('.jsonl','');
        if (chatFile && chatFile !== currentViewingChatFile) {
            chatListScrollTop = chatListItem.parentElement.scrollTop;
            await renderPromptView(chatFile);
        }
        return;
    }
}

async function handleSavePrompt() {
    const textarea = document.getElementById('custom-prompt-textarea');
    if (!textarea) return;

    const newPromptText = textarea.value;
    const chatFileToModify = currentViewingChatFile;

    const chatDataInCache = allChatsPromptData.find(c => String(c.fileName).replace('.jsonl', '') === chatFileToModify);
    if (!chatDataInCache) {
        toastr.error('错误: 找不到聊天缓存数据。');
        return;
    }

    // Ensure the metadata key exists
    if (!chatDataInCache.metadata[METADATA_KEY]) {
        chatDataInCache.metadata[METADATA_KEY] = {};
    }
    chatDataInCache.metadata[METADATA_KEY].prompt = newPromptText;

    try {
        const context = getContext();
        const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');

        if (chatFileToModify === currentContextChatIdNoExt) {
            // It's the currently active chat, use the efficient context update
            context.updateChatMetadata({
                [METADATA_KEY]: chatDataInCache.metadata[METADATA_KEY]
            });
            saveMetadataDebounced();
        } else {
            // It's a different chat, save it to its specific file
            await saveSpecificChatMetadata(chatFileToModify, chatDataInCache.metadata, chatDataInCache.messages);
        }
        
        // Apply the change immediately if it's the active chat
        if (chatFileToModify === currentContextChatIdNoExt) {
            applyOrClearCustomPrompt();
        }
        
        toastr.success('提示词已成功保存！');
        renderChatListPanel(); // Re-render to show/hide the checkmark indicator

    } catch (error) {
        console.error(`[${pluginName}] Failed to save prompt:`, error);
        toastr.error('保存提示词失败，请检查控制台。');
    }
}

// =================================================================
//        DATA FETCHING & SAVING (ADAPTED FROM 'STAR' PLUGIN)
// =================================================================

async function getAllChatDataForCurrentContext(skipCurrentChat = false) {
    const context = getContext();
    if (!context) return [];
    
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl','');
    let chatListResponse, requestBody, allData = [];

    const processChatList = async (list) => {
        for (const chatMeta of list) {
            const chatFileNameWithExt = chatMeta.file_name;
            const chatFileNameNoExt = String(chatFileNameWithExt || '').replace('.jsonl', '');
            if (!chatFileNameNoExt || (skipCurrentChat && chatFileNameNoExt === currentContextChatIdNoExt)) {
                continue;
            }
            const fullChatData = await getFullChatData(context.characterId, context.groupId, chatFileNameNoExt, !!context.groupId, chatMeta);
            // We load all chats that have *any* metadata, to show them in the list
            if (fullChatData) {
                allData.push({ 
                    fileName: chatFileNameNoExt, 
                    displayName: chatFileNameNoExt, 
                    metadata: fullChatData.metadata, 
                    messages: fullChatData.messages || [], 
                    isGroup: !!context.groupId, 
                    characterId: context.characterId,
                    groupId: context.groupId,
                });
            }
        }
    };

    if (context.groupId) {
        requestBody = { group_id: context.groupId, query: '' };
        try {
            chatListResponse = await fetch('/api/chats/search', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(requestBody) });
            if (chatListResponse.ok) await processChatList(await chatListResponse.json());
        } catch (error) { console.error(`[${pluginName}] Error fetching group chats:`, error); }
	} else if (context.characterId !== undefined && context.characters[context.characterId]) {
		const charObj = context.characters[context.characterId];
		requestBody = { avatar_url: charObj.avatar };
		try {
			chatListResponse = await fetch('/api/characters/chats', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(requestBody) });
            if (chatListResponse.ok) await processChatList(await chatListResponse.json());
		} catch (error) { console.error(`[${pluginName}] Error fetching character chats:`, error); }
    }
    
    return allData;
}

async function getFullChatData(characterId, groupId, chatFileNameNoExt, isGroup, providedMetadata = null) {
    // This function is complex but robust, adapted directly from the star plugin
    // to fetch full chat data including metadata and messages.
    const context = getContext();
    let endpoint, requestBody, finalMetadataObject = {}, messages = [];
    try {
        if (isGroup) {
            if (!groupId) return null;
            endpoint = '/api/chats/group/get';
            requestBody = { id: groupId, chat_id: chatFileNameNoExt };
            const response = await fetch(endpoint, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(requestBody) });
            if (response.ok) {
                const groupChatData = await response.json();
                if (Array.isArray(groupChatData) && groupChatData.length > 0 && typeof groupChatData[0] === 'object' && !Array.isArray(groupChatData[0])) {
                    finalMetadataObject = JSON.parse(JSON.stringify(groupChatData[0].chat_metadata || groupChatData[0]));
                    messages = groupChatData.slice(1);
                } else {
                    messages = groupChatData;
                }
            }
        } else {
            if (characterId === undefined || !context.characters[characterId]) return null;
            const charObj = context.characters[characterId];
            endpoint = '/api/chats/get';
            requestBody = { ch_name: charObj.name, file_name: chatFileNameNoExt, avatar_url: charObj.avatar };
            const response = await fetch(endpoint, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(requestBody) });
            if (!response.ok) return null;
            const chatDataResponse = await response.json();
            if (Array.isArray(chatDataResponse) && chatDataResponse.length > 0 && typeof chatDataResponse[0] === 'object' && !Array.isArray(chatDataResponse[0])) {
                finalMetadataObject = JSON.parse(JSON.stringify(chatDataResponse[0].chat_metadata || chatDataResponse[0]));
                messages = chatDataResponse.slice(1);
            } else {
                messages = Array.isArray(chatDataResponse) ? chatDataResponse : [];
            }
        }
        return { metadata: finalMetadataObject, messages };
    } catch (error) {
        console.error(`[${pluginName}] getFullChatData error for "${chatFileNameNoExt}":`, error);
        return { metadata: {}, messages: [] };
    }
}

async function saveSpecificChatMetadata(chatFileNameNoExt, metadataToSave, messagesArray = null) {
    // This function is also adapted from the star plugin to save changes to non-active chats.
    const context = getContext();
    try {
        if (messagesArray === null) {
            const fullChatData = await getFullChatData(context.characterId, context.groupId, chatFileNameNoExt, !!context.groupId);
            if (!fullChatData || !fullChatData.messages) { throw new Error('Could not load chat messages to save.'); }
            messagesArray = fullChatData.messages;
        }

        const finalMetadataObjectForSave = { ...metadataToSave, chat_metadata: metadataToSave };
        let chatContentToSave = [finalMetadataObjectForSave, ...messagesArray];

        let requestBody = { chat: chatContentToSave, file_name: chatFileNameNoExt, force: true };
        if (!!context.groupId) {
            if (!context.groupId) throw new Error("Group ID unknown.");
            requestBody.is_group = true;
            requestBody.id = context.groupId;
        } else {
            if (context.characterId === undefined) throw new Error("Character info unknown.");
            const charObj = context.characters[context.characterId];
            requestBody.ch_name = charObj.name;
            requestBody.avatar_url = charObj.avatar;
        }

        const response = await fetch('/api/chats/save', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(requestBody), cache: 'no-cache' });
        if (!response.ok) {
            throw new Error(`Server responded with ${response.status}: ${await response.text()}`);
        }
    } catch (error) {
        console.error(`[${pluginName}] Error in saveSpecificChatMetadata for ${chatFileNameNoExt}`, error);
        toastr.error(`保存聊天 "${chatFileNameNoExt}" 的提示词时发生错误: ${error.message}`);
    }
}


// =================================================================
//                      PLUGIN INITIALIZATION
// =================================================================
jQuery(async () => {
    try {
        const inputButtonHtml = `<div id="custom_prompt_button" class="list-group-item flex-container">
            <i class="fa-solid fa-scroll"></i>
            <div class="menu_text">自定义提示词</div>
        </div>`;
        $('#extensions_buttons').append(inputButtonHtml);
        $('#custom_prompt_button').on('click', openPromptModal);
        
        // Listen for chat changes to apply the correct prompt
        eventSource.on(event_types.CHAT_CHANGED, () => {
            // Apply the prompt for the newly loaded chat
            applyOrClearCustomPrompt();
        });

        // Initial application of the prompt for the currently open chat
        applyOrClearCustomPrompt();

        console.log(`[${pluginName}] Plugin loaded successfully.`);
    } catch (error) {
        console.error(`[${pluginName}] Initialization failed:`, error);
    }
});
