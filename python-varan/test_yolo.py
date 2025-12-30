import numpy as np

import yolo
import utility
import cv2

from rknnlite.api import RKNNLite

from yolo import draw_yolo_boxes


def preprocess(img):
    img = cv2.resize(img, (640, 640))
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    #img = img.astype(np.float32) / 255.0
    img = np.expand_dims(img, axis=0)
    return img

def run():

    classes, data = utility.load_classes_from_json("models/classes/classes-coco.json")

    rknn = RKNNLite()
    ret = rknn.load_rknn("models/weights/yolo11n-640.rknn")
    if ret != 0:
        print("Failed to load RKNN")
        return

    ret = rknn.init_runtime()
    if ret != 0:
        print(f"Failed to init rknn runtime with core mask: {1}")
        return

    cap = cv2.VideoCapture("test_video/video_segment_2025-06-16--10-28-42.mp4")

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break

        input_data = preprocess(frame)

        output = rknn.inference(inputs = [input_data])
        results = yolo.postprocess_default_yolo(
            output[0],
            0.5,
            0.5
        )

        postprocess_frame = draw_yolo_boxes(
            input_data[0],
            results,
            classes
        )
        cv2.imshow("frame", postprocess_frame)

        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    cap.release()
    cv2.destroyAllWindows()

if __name__ == '__main__':
    run()