// Определения для полей json, который используется для обмена сообщениями

#define SIG_RET "ret"
#define SIG_TYPE "type"
#define SIG_CLIENT "client_id"
#define SIG_CAMERA "camera"
#define SIG_DECRIPTION "description"
#define SIG_SENDER "sender"

// Варинты полей RET
#define SIG_RET_FAULT "fault"
#define SIG_RET_SUCCESS "success"

// Варинты полея type
#define SIG_TYPE_CONNECT "connection"
#define SIG_TYPE_OPEN "open"
#define SIG_TYPE_CLOSE "close"
#define SIG_TYPE_ICE "ice"
#define SIG_TYPE_OFFER "offer"
#define SIG_TYPE_ANSWER "answer"

// Варианты полей sender
#define SIG_SENDER_CLIENT "client"
#define SIG_SENDER_CAMERA "camera"

// Дополнительные поля для ICE
#define SIG_ICE_CANDIDATE "candidate"
#define SIG_ICE_LINE_INDEX "sdpMLineIndex"

// Дополнительные поля для sdp
#define SIG_SDP "sdp"
