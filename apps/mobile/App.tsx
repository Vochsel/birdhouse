import { createBirdhouseClient } from "@birdhouse/client";
import type {
  Attachment,
  AuthConfig,
  Contact,
  Message
} from "@birdhouse/protocol";
import * as Device from "expo-device";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import {
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";

import {
  loadContacts,
  loadThreads,
  saveContacts,
  saveThreads,
  ThreadStore
} from "./src/storage";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true
  })
});

const client = createBirdhouseClient();

type Screen = "threads" | "chat" | "contact";

type DraftContact = {
  displayName: string;
  endpointUrl: string;
  authType: AuthConfig["type"];
  bearerToken: string;
  basicUsername: string;
  basicPassword: string;
  extraJson: string;
};

const defaultDraft: DraftContact = {
  displayName: "",
  endpointUrl: "http://localhost:8787",
  authType: "none",
  bearerToken: "",
  basicUsername: "",
  basicPassword: "",
  extraJson: "{}"
};

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getThreadId(contactId: string): string {
  return `${contactId}-default`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

function buildAuthConfig(draft: DraftContact): AuthConfig {
  if (draft.authType === "bearer") {
    return {
      type: "bearer",
      token: draft.bearerToken.trim()
    };
  }

  if (draft.authType === "basic") {
    return {
      type: "basic",
      username: draft.basicUsername.trim(),
      password: draft.basicPassword.trim()
    };
  }

  return {
    type: "none"
  };
}

function parseExtra(extraJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(extraJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }

  return {};
}

function draftFromContact(contact: Contact): DraftContact {
  const auth = contact.provider.auth;
  return {
    displayName: contact.displayName,
    endpointUrl: contact.provider.baseUrl,
    authType: auth.type,
    bearerToken: auth.type === "bearer" ? auth.token : "",
    basicUsername: auth.type === "basic" ? auth.username : "",
    basicPassword: auth.type === "basic" ? auth.password : "",
    extraJson: JSON.stringify(contact.provider.extra ?? {}, null, 2)
  };
}

function normalizeMessageStatusForRead(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role === "agent" && (message.status === "received" || message.status === "sent")) {
      return {
        ...message,
        status: "read"
      };
    }

    return message;
  });
}

async function registerForPushNotificationsAsync(): Promise<string | null> {
  if (!Device.isDevice) {
    return null;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== "granted") {
    return null;
  }

  const token = await Notifications.getExpoPushTokenAsync();
  return token.data;
}

export default function App() {
  const [isHydrated, setIsHydrated] = useState(false);
  const [screen, setScreen] = useState<Screen>("threads");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [threads, setThreads] = useState<ThreadStore>({});
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [composerText, setComposerText] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [typingByThread, setTypingByThread] = useState<Record<string, boolean>>({});
  const [isSending, setIsSending] = useState(false);
  const [isSavingContact, setIsSavingContact] = useState(false);
  const [draftContact, setDraftContact] = useState<DraftContact>(defaultDraft);
  const [editingContactId, setEditingContactId] = useState<string | null>(null);
  const [openContactMenuId, setOpenContactMenuId] = useState<string | null>(null);
  const [pushToken, setPushToken] = useState<string | null>(null);
  const notificationListener = useRef<Notifications.EventSubscription | null>(null);
  const responseListener = useRef<Notifications.EventSubscription | null>(null);
  const chatScrollRef = useRef<ScrollView | null>(null);

  const selectedContact = useMemo(
    () => contacts.find((contact) => contact.id === selectedContactId) ?? null,
    [contacts, selectedContactId]
  );

  const selectedThreadId = selectedContact ? getThreadId(selectedContact.id) : null;
  const selectedMessages = selectedThreadId ? threads[selectedThreadId] ?? [] : [];

  useEffect(() => {
    void (async () => {
      const [storedContacts, storedThreads] = await Promise.all([loadContacts(), loadThreads()]);
      setContacts(storedContacts);
      setThreads(storedThreads);
      setIsHydrated(true);
    })();
  }, []);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    void saveContacts(contacts);
  }, [contacts, isHydrated]);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    void saveThreads(threads);
  }, [threads, isHydrated]);

  useEffect(() => {
    void (async () => {
      const token = await registerForPushNotificationsAsync();
      setPushToken(token);
    })();

    notificationListener.current = Notifications.addNotificationReceivedListener((notification) => {
      const data = notification.request.content.data as Record<string, string>;
      const contactId = data.contactId;
      const threadId = data.threadId;
      const text = data.text;

      if (!contactId || !threadId || !text) {
        return;
      }

      setThreads((current) => {
        const list = current[threadId] ?? [];
        const message: Message = {
          id: generateId(),
          threadId,
          role: "agent",
          text,
          attachments: [],
          status: "received",
          createdAt: new Date().toISOString()
        };
        return {
          ...current,
          [threadId]: [...list, message]
        };
      });

      if (selectedContactId === contactId) {
        setScreen("chat");
      }
    });

    responseListener.current = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as Record<string, string>;
      const contactId = data.contactId;

      if (contactId) {
        setSelectedContactId(contactId);
        setScreen("chat");
      }
    });

    return () => {
      notificationListener.current?.remove();
      responseListener.current?.remove();
    };
  }, [selectedContactId]);

  useEffect(() => {
    if (!selectedContact || !pushToken) {
      return;
    }

    void client.registerPush({
      endpoint: {
        baseUrl: selectedContact.provider.baseUrl,
        auth: selectedContact.provider.auth
      },
      registration: {
        contactId: selectedContact.id,
        threadId: getThreadId(selectedContact.id),
        expoPushToken: pushToken,
        platform: Platform.OS === "ios" ? "ios" : "android"
      }
    }).catch(() => {
      // Ignore registration errors so messaging still works.
    });
  }, [selectedContact, pushToken]);

  useEffect(() => {
    if (!selectedThreadId) {
      return;
    }

    setThreads((current) => ({
      ...current,
      [selectedThreadId]: normalizeMessageStatusForRead(current[selectedThreadId] ?? [])
    }));
  }, [selectedThreadId]);

  function scrollChatToBottom(animated = false): void {
    requestAnimationFrame(() => {
      chatScrollRef.current?.scrollToEnd({ animated });
    });
  }

  useEffect(() => {
    if (screen !== "chat" || !selectedThreadId) {
      return;
    }

    scrollChatToBottom(false);
  }, [screen, selectedThreadId]);

  function openChat(contactId: string): void {
    setOpenContactMenuId(null);
    setSelectedContactId(contactId);
    setScreen("chat");
  }

  function openContactEditor(): void {
    setOpenContactMenuId(null);
    setEditingContactId(null);
    setDraftContact(defaultDraft);
    setScreen("contact");
  }

  function openContactEditorForEdit(contactId: string): void {
    const contact = contacts.find((item) => item.id === contactId);
    if (!contact) {
      Alert.alert("Contact missing", "Unable to find that contact.");
      return;
    }

    setEditingContactId(contact.id);
    setDraftContact(draftFromContact(contact));
    setOpenContactMenuId(null);
    setScreen("contact");
  }

  function deleteContact(contactId: string): void {
    setOpenContactMenuId(null);
    const contact = contacts.find((item) => item.id === contactId);
    if (!contact) {
      return;
    }

    Alert.alert(
      "Delete Contact",
      `Remove ${contact.displayName}? This also removes this conversation history.`,
      [
        {
          text: "Cancel",
          style: "cancel"
        },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            const threadId = getThreadId(contactId);
            setContacts((current) => current.filter((item) => item.id !== contactId));
            setThreads((current) => {
              const next = { ...current };
              delete next[threadId];
              return next;
            });
            setTypingByThread((current) => {
              const next = { ...current };
              delete next[threadId];
              return next;
            });

            if (selectedContactId === contactId) {
              setSelectedContactId(null);
              setScreen("threads");
            }

            if (editingContactId === contactId) {
              setEditingContactId(null);
              setDraftContact(defaultDraft);
            }

            setScreen("threads");
          }
        }
      ]
    );
  }

  async function saveContact(): Promise<void> {
    if (!draftContact.displayName.trim()) {
      Alert.alert("Missing name", "Please enter a display name.");
      return;
    }

    if (!draftContact.endpointUrl.trim()) {
      Alert.alert("Missing endpoint", "Please enter an endpoint URL.");
      return;
    }

    setIsSavingContact(true);

    try {
      const auth = buildAuthConfig(draftContact);
      const endpoint = draftContact.endpointUrl.trim();
      const discoveredKind = await client.discoverProvider({
        baseUrl: endpoint,
        auth
      });

      const isEditing = Boolean(editingContactId);
      const contactId = editingContactId ?? generateId();
      const contact: Contact = {
        id: contactId,
        displayName: draftContact.displayName.trim(),
        provider: {
          kind: discoveredKind,
          baseUrl: endpoint,
          auth,
          extra: parseExtra(draftContact.extraJson)
        }
      };

      if (isEditing) {
        setContacts((current) => current.map((item) => (item.id === contactId ? contact : item)));
      } else {
        setContacts((current) => [contact, ...current]);
      }

      setEditingContactId(null);
      setDraftContact(defaultDraft);
      setScreen("threads");
      Alert.alert(isEditing ? "Contact updated" : "Contact saved", `Discovered provider: ${discoveredKind}`);
    } catch (error) {
      Alert.alert("Provider discovery failed", error instanceof Error ? error.message : "Unknown error");
    } finally {
      setIsSavingContact(false);
    }
  }

  async function pickImage(): Promise<void> {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission required", "Photo library permission is required to attach images.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      quality: 0.8,
      allowsEditing: false
    });

    if (result.canceled || !result.assets.length) {
      return;
    }

    const asset = result.assets[0];
    const attachment: Attachment = {
      id: generateId(),
      kind: "image",
      name: asset.fileName ?? `image-${Date.now()}.jpg`,
      mimeType: asset.mimeType ?? "image/jpeg",
      sizeBytes: asset.fileSize,
      uri: asset.uri
    };

    setPendingAttachments((current) => [...current, attachment]);
  }

  async function pickFile(): Promise<void> {
    const result = await DocumentPicker.getDocumentAsync({
      multiple: false,
      copyToCacheDirectory: true
    });

    if (result.canceled || !result.assets.length) {
      return;
    }

    const asset = result.assets[0];
    const attachment: Attachment = {
      id: generateId(),
      kind: asset.mimeType?.startsWith("image/") ? "image" : "file",
      name: asset.name,
      mimeType: asset.mimeType,
      sizeBytes: asset.size,
      uri: asset.uri
    };

    setPendingAttachments((current) => [...current, attachment]);
  }

  async function sendMessage(): Promise<void> {
    if (!selectedContact || !selectedThreadId) {
      return;
    }

    const trimmedText = composerText.trim();
    if (!trimmedText.length && !pendingAttachments.length) {
      return;
    }

    setIsSending(true);

    const userMessage: Message = {
      id: generateId(),
      threadId: selectedThreadId,
      role: "user",
      text: trimmedText,
      attachments: pendingAttachments,
      status: "sent",
      createdAt: new Date().toISOString()
    };

    const priorThread = threads[selectedThreadId] ?? [];

    setThreads((current) => ({
      ...current,
      [selectedThreadId]: [...(current[selectedThreadId] ?? []), userMessage]
    }));
    scrollChatToBottom(true);

    setComposerText("");
    setPendingAttachments([]);

    const agentMessageId = generateId();
    setThreads((current) => ({
      ...current,
      [selectedThreadId]: [
        ...(current[selectedThreadId] ?? []),
        {
          id: agentMessageId,
          threadId: selectedThreadId,
          role: "agent",
          text: "",
          attachments: [],
          status: "streaming",
          createdAt: new Date().toISOString()
        }
      ]
    }));
    scrollChatToBottom(false);

    setTypingByThread((current) => ({
      ...current,
      [selectedThreadId]: true
    }));

    let accumulatedText = "";
    let receivedMessageEnd = false;

    try {
      for await (const event of client.chatStream({
        endpoint: {
          baseUrl: selectedContact.provider.baseUrl,
          auth: selectedContact.provider.auth
        },
        request: {
          threadId: selectedThreadId,
          contact: selectedContact,
          message: {
            id: userMessage.id,
            text: trimmedText,
            attachments: userMessage.attachments
          },
          history: priorThread,
          metadata: {
            source: "birdhouse-mobile"
          }
        }
      })) {
        if (event.type === "typing") {
          setTypingByThread((current) => ({
            ...current,
            [selectedThreadId]: event.isTyping
          }));
        }

        if (event.type === "token") {
          accumulatedText += event.text;
          setThreads((current) => ({
            ...current,
            [selectedThreadId]: (current[selectedThreadId] ?? []).map((message) =>
              message.id === agentMessageId
                ? {
                    ...message,
                    text: accumulatedText
                  }
                : message
            )
          }));
          scrollChatToBottom(false);
        }

        if (event.type === "attachment") {
          setThreads((current) => ({
            ...current,
            [selectedThreadId]: (current[selectedThreadId] ?? []).map((message) =>
              message.id === agentMessageId
                ? {
                    ...message,
                    attachments: [...message.attachments, event.attachment]
                  }
                : message
            )
          }));
          scrollChatToBottom(false);
        }

        if (event.type === "message_end") {
          receivedMessageEnd = true;
          setThreads((current) => ({
            ...current,
            [selectedThreadId]: (current[selectedThreadId] ?? []).map((message) =>
              message.id === agentMessageId
                ? {
                    ...message,
                    text: accumulatedText || event.text,
                    status: "received"
                  }
                : message
            )
          }));
          scrollChatToBottom(false);
          setTypingByThread((current) => ({
            ...current,
            [selectedThreadId]: false
          }));
        }

        if (event.type === "error") {
          throw new Error(event.message);
        }
      }

      if (!receivedMessageEnd) {
        const hasText = accumulatedText.trim().length > 0;
        setThreads((current) => ({
          ...current,
          [selectedThreadId]: (current[selectedThreadId] ?? []).map((message) =>
            message.id === agentMessageId
              ? {
                  ...message,
                  text: accumulatedText,
                  status: hasText ? "received" : "failed"
                }
              : message
          )
        }));

        if (!hasText) {
          Alert.alert("No response", "The agent stream ended before a complete response was received.");
        }
      }
    } catch (error) {
      setThreads((current) => ({
        ...current,
        [selectedThreadId]: (current[selectedThreadId] ?? []).map((message) =>
          message.id === agentMessageId
            ? {
                ...message,
                status: "failed"
              }
              : message
        )
      }));
      scrollChatToBottom(false);

      Alert.alert("Send failed", error instanceof Error ? error.message : "Unknown error");
    } finally {
      setTypingByThread((current) => ({
        ...current,
        [selectedThreadId]: false
      }));
      setIsSending(false);
      scrollChatToBottom(false);
    }
  }

  function renderThreadsScreen() {
    return (
      <View style={styles.root}>
        <View style={styles.threadHeader}>
          <Text style={styles.screenTitle}>Messages</Text>
          <Pressable style={styles.headerButton} onPress={openContactEditor}>
            <Text style={styles.headerButtonText}>New Agent</Text>
          </Pressable>
        </View>

        <FlatList
          data={contacts}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.threadList}
          ListEmptyComponent={<Text style={styles.emptyText}>Add an agent contact to start chatting.</Text>}
          renderItem={({ item }) => {
            const threadId = getThreadId(item.id);
            const thread = threads[threadId] ?? [];
            const lastMessage = thread[thread.length - 1];

            return (
              <View style={styles.threadCard}>
                <Pressable style={styles.threadCardContent} onPress={() => openChat(item.id)}>
                  <View style={styles.threadCardTop}>
                    <Text style={styles.threadName}>{item.displayName}</Text>
                    <Text style={styles.threadTime}>{lastMessage ? formatTime(lastMessage.createdAt) : ""}</Text>
                  </View>
                  <Text style={styles.threadPreview} numberOfLines={1}>
                    {lastMessage ? lastMessage.text || "Attachment" : `${item.provider.kind} · ${item.provider.baseUrl}`}
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.threadMenuTrigger}
                  onPress={() => setOpenContactMenuId((current) => (current === item.id ? null : item.id))}
                >
                  <Text style={styles.threadMenuTriggerText}>•••</Text>
                </Pressable>
                {openContactMenuId === item.id && (
                  <View style={styles.threadMenuDropdown}>
                    <Pressable
                      style={styles.threadMenuItem}
                      onPress={() => {
                        openContactEditorForEdit(item.id);
                      }}
                    >
                      <Text style={styles.threadMenuItemText}>Edit</Text>
                    </Pressable>
                    <Pressable
                      style={styles.threadMenuItem}
                      onPress={() => {
                        deleteContact(item.id);
                      }}
                    >
                      <Text style={[styles.threadMenuItemText, styles.threadMenuDeleteItemText]}>Delete</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            );
          }}
        />
      </View>
    );
  }

  function renderMessage(message: Message) {
    const isUser = message.role === "user";

    return (
      <View style={[styles.bubbleWrapper, isUser ? styles.userBubbleWrapper : styles.agentBubbleWrapper]} key={message.id}>
        <View style={[styles.bubble, isUser ? styles.userBubble : styles.agentBubble]}>
          {message.attachments.length > 0 && (
            <View style={styles.attachmentStack}>
              {message.attachments.map((attachment) => (
                <View style={styles.attachmentCard} key={attachment.id ?? `${message.id}-${attachment.name}`}>
                  {attachment.kind === "image" && attachment.uri ? (
                    <Image source={{ uri: attachment.uri }} style={styles.attachmentImage} />
                  ) : (
                    <Text style={styles.attachmentIcon}>FILE</Text>
                  )}
                  <Text style={styles.attachmentName}>{attachment.name}</Text>
                </View>
              ))}
            </View>
          )}
          {message.text.length > 0 && <Text style={isUser ? styles.userText : styles.agentText}>{message.text}</Text>}
        </View>
        <Text style={styles.messageMeta}>{formatTime(message.createdAt)} · {message.status}</Text>
      </View>
    );
  }

  function renderChatScreen() {
    if (!selectedContact || !selectedThreadId) {
      return null;
    }

    return (
      <View style={styles.root}>
        <View style={styles.chatHeader}>
          <Pressable style={styles.backButton} onPress={() => setScreen("threads")}>
            <Text style={styles.backButtonText}>Back</Text>
          </Pressable>
          <Text style={styles.chatTitle}>{selectedContact.displayName}</Text>
          <View style={styles.chatHeaderSpacer} />
        </View>

        <ScrollView
          ref={chatScrollRef}
          contentContainerStyle={styles.chatBody}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => {
            scrollChatToBottom(false);
          }}
        >
          {selectedMessages.map((message) => renderMessage(message))}
          {typingByThread[selectedThreadId] && (
            <View style={styles.typingContainer}>
              <ActivityIndicator size="small" color="#5f6573" />
              <Text style={styles.typingText}>Agent is typing…</Text>
            </View>
          )}
        </ScrollView>

        {pendingAttachments.length > 0 && (
          <ScrollView horizontal contentContainerStyle={styles.pendingAttachmentRow}>
            {pendingAttachments.map((attachment) => (
              <View style={styles.pendingAttachment} key={attachment.id}>
                <Text style={styles.pendingAttachmentText}>{attachment.name}</Text>
              </View>
            ))}
          </ScrollView>
        )}

        <View style={styles.composerShell}>
          <View style={styles.composerButtons}>
            <Pressable style={styles.roundButton} onPress={() => void pickImage()}>
              <Text style={styles.roundButtonText}>Img</Text>
            </Pressable>
            <Pressable style={styles.roundButton} onPress={() => void pickFile()}>
              <Text style={styles.roundButtonText}>File</Text>
            </Pressable>
          </View>
          <TextInput
            placeholder="iMessage"
            placeholderTextColor="#8f95a3"
            style={styles.composerInput}
            value={composerText}
            onChangeText={setComposerText}
            multiline
          />
          <Pressable style={styles.sendButton} onPress={() => void sendMessage()} disabled={isSending}>
            <Text style={styles.sendButtonText}>{isSending ? "..." : "Send"}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  function renderContactScreen() {
    const isEditing = Boolean(editingContactId);
    return (
      <View style={styles.root}>
        <View style={styles.contactHeader}>
          <Pressable
            style={styles.backButton}
            onPress={() => {
              setEditingContactId(null);
              setDraftContact(defaultDraft);
              setScreen("threads");
            }}
          >
            <Text style={styles.backButtonText}>Back</Text>
          </Pressable>
          <Text style={styles.screenTitle}>{isEditing ? "Edit Agent Contact" : "New Agent Contact"}</Text>
        </View>

        <ScrollView contentContainerStyle={styles.formBody}>
          <Text style={styles.inputLabel}>Display Name</Text>
          <TextInput
            style={styles.textInput}
            value={draftContact.displayName}
            onChangeText={(value) => setDraftContact((current) => ({ ...current, displayName: value }))}
            placeholder="Agent Name"
            placeholderTextColor="#8f95a3"
          />

          <Text style={styles.inputLabel}>Endpoint URL (Birdhouse server)</Text>
          <TextInput
            style={styles.textInput}
            value={draftContact.endpointUrl}
            onChangeText={(value) => setDraftContact((current) => ({ ...current, endpointUrl: value }))}
            placeholder="https://your-endpoint"
            placeholderTextColor="#8f95a3"
            autoCapitalize="none"
            keyboardType="url"
          />
          <Text style={styles.helperText}>Provider is discovered automatically from this endpoint.</Text>

          <Text style={styles.inputLabel}>Auth</Text>
          <View style={styles.segmentRow}>
            {(["none", "bearer", "basic"] as AuthConfig["type"][]).map((authType) => (
              <Pressable
                key={authType}
                style={[styles.segmentButton, draftContact.authType === authType && styles.segmentButtonActive]}
                onPress={() => setDraftContact((current) => ({ ...current, authType }))}
              >
                <Text style={[styles.segmentButtonText, draftContact.authType === authType && styles.segmentButtonTextActive]}>
                  {authType}
                </Text>
              </Pressable>
            ))}
          </View>

          {draftContact.authType === "bearer" && (
            <>
              <Text style={styles.inputLabel}>Bearer Token</Text>
              <TextInput
                style={styles.textInput}
                value={draftContact.bearerToken}
                onChangeText={(value) => setDraftContact((current) => ({ ...current, bearerToken: value }))}
                placeholder="Token"
                placeholderTextColor="#8f95a3"
                autoCapitalize="none"
              />
            </>
          )}

          {draftContact.authType === "basic" && (
            <>
              <Text style={styles.inputLabel}>Basic Username</Text>
              <TextInput
                style={styles.textInput}
                value={draftContact.basicUsername}
                onChangeText={(value) => setDraftContact((current) => ({ ...current, basicUsername: value }))}
                placeholder="Username"
                placeholderTextColor="#8f95a3"
                autoCapitalize="none"
              />
              <Text style={styles.inputLabel}>Basic Password</Text>
              <TextInput
                style={styles.textInput}
                value={draftContact.basicPassword}
                onChangeText={(value) => setDraftContact((current) => ({ ...current, basicPassword: value }))}
                placeholder="Password"
                placeholderTextColor="#8f95a3"
                secureTextEntry
              />
            </>
          )}

          <Text style={styles.inputLabel}>Provider Extra JSON</Text>
          <TextInput
            style={[styles.textInput, styles.multilineInput]}
            value={draftContact.extraJson}
            onChangeText={(value) => setDraftContact((current) => ({ ...current, extraJson: value }))}
            placeholder='{"path":"/chat"}'
            placeholderTextColor="#8f95a3"
            autoCapitalize="none"
            multiline
          />

          <Pressable
            style={[styles.saveContactButton, isSavingContact && styles.saveContactButtonDisabled]}
            onPress={() => void saveContact()}
            disabled={isSavingContact}
          >
            <Text style={styles.saveContactButtonText}>
              {isSavingContact ? "Discovering..." : isEditing ? "Update Contact" : "Save Contact"}
            </Text>
          </Pressable>

          {editingContactId && (
            <Pressable style={styles.deleteContactButton} onPress={() => deleteContact(editingContactId)}>
              <Text style={styles.deleteContactButtonText}>Delete Contact</Text>
            </Pressable>
          )}
        </ScrollView>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView
        style={styles.keyboardAvoiding}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}
      >
        {!isHydrated ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#0f71f3" />
            <Text style={styles.loadingText}>Loading Birdhouse…</Text>
          </View>
        ) : null}
        {isHydrated && screen === "threads" ? renderThreadsScreen() : null}
        {isHydrated && screen === "chat" ? renderChatScreen() : null}
        {isHydrated && screen === "contact" ? renderContactScreen() : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#f4f6fb"
  },
  root: {
    flex: 1,
    backgroundColor: "#f4f6fb"
  },
  keyboardAvoiding: {
    flex: 1
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10
  },
  loadingText: {
    color: "#69707f",
    fontSize: 15
  },
  threadHeader: {
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  screenTitle: {
    fontSize: 32,
    fontWeight: "700",
    color: "#111826"
  },
  headerButton: {
    backgroundColor: "#0f71f3",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  headerButtonText: {
    color: "#ffffff",
    fontWeight: "600"
  },
  threadList: {
    paddingHorizontal: 14,
    paddingBottom: 24,
    gap: 10
  },
  emptyText: {
    textAlign: "center",
    color: "#7d8596",
    marginTop: 40
  },
  threadCard: {
    backgroundColor: "#ffffff",
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "#e5eaf5",
    position: "relative"
  },
  threadCardContent: {
    paddingRight: 34
  },
  threadCardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center"
  },
  threadName: {
    fontSize: 18,
    fontWeight: "600",
    color: "#101626"
  },
  threadTime: {
    color: "#7f8797",
    fontSize: 12
  },
  threadPreview: {
    marginTop: 5,
    color: "#60697a",
    fontSize: 14
  },
  threadMenuTrigger: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f4f7fd"
  },
  threadMenuTriggerText: {
    fontSize: 13,
    color: "#3c4b69",
    fontWeight: "700"
  },
  threadMenuDropdown: {
    position: "absolute",
    top: 38,
    right: 10,
    minWidth: 118,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#dbe2f0",
    borderRadius: 12,
    paddingVertical: 6,
    shadowColor: "#000000",
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: {
      width: 0,
      height: 4
    },
    elevation: 6,
    zIndex: 30
  },
  threadMenuItem: {
    paddingHorizontal: 12,
    paddingVertical: 9
  },
  threadMenuItemText: {
    color: "#2f4269",
    fontSize: 14,
    fontWeight: "600"
  },
  threadMenuDeleteItemText: {
    color: "#b13b4b"
  },
  chatHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 8,
    borderBottomColor: "#dde2ef",
    borderBottomWidth: 1,
    backgroundColor: "#f8f9fc"
  },
  backButton: {
    paddingHorizontal: 10,
    paddingVertical: 8
  },
  backButtonText: {
    color: "#0f71f3",
    fontWeight: "600"
  },
  chatTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#12192a"
  },
  chatHeaderSpacer: {
    width: 48
  },
  chatBody: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 20,
    gap: 8
  },
  bubbleWrapper: {
    marginBottom: 8,
    maxWidth: "82%"
  },
  userBubbleWrapper: {
    alignSelf: "flex-end"
  },
  agentBubbleWrapper: {
    alignSelf: "flex-start"
  },
  bubble: {
    borderRadius: 24,
    paddingHorizontal: 14,
    paddingVertical: 10
  },
  userBubble: {
    backgroundColor: "#0f71f3"
  },
  agentBubble: {
    backgroundColor: "#e3e8f2"
  },
  userText: {
    color: "#ffffff",
    fontSize: 16,
    lineHeight: 22
  },
  agentText: {
    color: "#101726",
    fontSize: 16,
    lineHeight: 22
  },
  messageMeta: {
    marginTop: 4,
    fontSize: 11,
    color: "#7d8594",
    alignSelf: "flex-end"
  },
  typingContainer: {
    marginTop: 2,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  typingText: {
    color: "#5f6573"
  },
  composerShell: {
    marginHorizontal: 10,
    marginBottom: 10,
    backgroundColor: "#ffffff",
    borderRadius: 24,
    borderColor: "#d7ddeb",
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8
  },
  composerButtons: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6
  },
  roundButton: {
    backgroundColor: "#e5eaf5",
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center"
  },
  roundButtonText: {
    color: "#42506d",
    fontSize: 11,
    fontWeight: "700"
  },
  composerInput: {
    flex: 1,
    maxHeight: 120,
    paddingVertical: 8,
    paddingHorizontal: 10,
    fontSize: 16,
    color: "#162033"
  },
  sendButton: {
    backgroundColor: "#0f71f3",
    borderRadius: 16,
    paddingVertical: 9,
    paddingHorizontal: 14
  },
  sendButtonText: {
    color: "#ffffff",
    fontWeight: "700"
  },
  pendingAttachmentRow: {
    paddingHorizontal: 10,
    paddingBottom: 8,
    gap: 8
  },
  pendingAttachment: {
    backgroundColor: "#e8edf8",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5
  },
  pendingAttachmentText: {
    color: "#2f3a52",
    fontSize: 12
  },
  attachmentStack: {
    marginBottom: 8,
    gap: 8
  },
  attachmentCard: {
    backgroundColor: "rgba(255,255,255,0.16)",
    borderRadius: 12,
    padding: 8,
    minWidth: 120
  },
  attachmentImage: {
    width: 120,
    height: 90,
    borderRadius: 8,
    marginBottom: 6
  },
  attachmentIcon: {
    fontSize: 12,
    fontWeight: "700",
    color: "#23314f",
    marginBottom: 5
  },
  attachmentName: {
    color: "#1f2a40",
    fontSize: 12
  },
  contactHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 8
  },
  formBody: {
    paddingHorizontal: 16,
    paddingBottom: 32
  },
  inputLabel: {
    marginTop: 16,
    marginBottom: 6,
    fontSize: 13,
    fontWeight: "700",
    color: "#33405c"
  },
  helperText: {
    marginTop: 6,
    color: "#6b7385",
    fontSize: 12
  },
  textInput: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#d6ddeb",
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#13203a",
    fontSize: 15
  },
  multilineInput: {
    minHeight: 84,
    textAlignVertical: "top"
  },
  segmentRow: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap"
  },
  segmentButton: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#cfd7e7",
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: "#ffffff"
  },
  segmentButtonActive: {
    borderColor: "#0f71f3",
    backgroundColor: "#e9f2ff"
  },
  segmentButtonText: {
    color: "#4d5870",
    fontSize: 13,
    fontWeight: "600"
  },
  segmentButtonTextActive: {
    color: "#0f71f3"
  },
  saveContactButton: {
    marginTop: 24,
    backgroundColor: "#0f71f3",
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center"
  },
  deleteContactButton: {
    marginTop: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#f2c0ca",
    backgroundColor: "#fff3f6",
    paddingVertical: 12,
    alignItems: "center"
  },
  deleteContactButtonText: {
    color: "#a13343",
    fontWeight: "700",
    fontSize: 15
  },
  saveContactButtonDisabled: {
    opacity: 0.7
  },
  saveContactButtonText: {
    color: "#ffffff",
    fontWeight: "700",
    fontSize: 15
  }
});
