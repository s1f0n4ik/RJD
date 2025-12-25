from typing import Any

import cv2
import numpy as np

from main_config import JSON_CLASSES_BBOX, JSON_CLASSES_CONFIDENCE, JSON_CLASSES_CLASS_ID, JSON_CLASSES_COLOR, \
    JSON_CLASSES_NAME


def box_iou(box1: list[int], box2: list[int]):
    x1 = max(box1[0], box2[0])
    y1 = max(box1[1], box2[1])
    x2 = min(box1[2], box2[2])
    y2 = min(box1[3], box2[3])

    intersection_width = max(0.0 , x2 - x1)
    intersection_height = max(0.0 , y2 - y1)
    intersection_area = intersection_width * intersection_height

    area_1 = (box1[2] - box1[0]) * (box1[3] - box1[1])
    area_2 = (box2[2] - box2[0]) * (box2[3] - box2[1])

    union_area = area_1 + area_2 - intersection_area
    return intersection_area / union_area if union_area > 0.0 else 0.0

def nms(boxes: list[list[int]], scores: list[float], iou_threshold: float):
    indices = np.argsort(scores)[::-1]
    keep = []

    while len(indices) > 0:
        current = indices[0]
        keep.append(current)

        rest = indices[1:]
        suppressed = []

        for i in rest:
            if box_iou(boxes[current], boxes[i]) < iou_threshold:
                suppressed.append(i)

        indices = np.array(suppressed)

    return keep

def postprocess_default_yolo(
        output: np.ndarray,
        confidence_threshold: float,
        iou_threshold: float,
        image_size: tuple[int, int],
    ):
    predictions = output[0].transpose(1, 0)

    boxes = predictions[:, :4]
    scores = predictions[:, 4:]

    class_ids = np.argmax(scores, axis=1)
    confidences = scores[np.arange(len(class_ids)), class_ids]

    mask = confidences >= confidence_threshold
    if not np.any(mask):
        return []

    boxes = boxes[mask]
    scores = scores[mask]
    class_ids = class_ids[mask]

    cx, cy, w, h = boxes.T
    img_w, img_h = image_size

    x1 = (cx - w / 2) * img_w
    y1 = (cy - h / 2) * img_h
    x2 = (cx + w / 2) * img_w
    y2 = (cy + h / 2) * img_h

    boxes_xyxy = np.stack([x1, y1, x2, y2], axis=1)

    if len(boxes) == 0:
        return []

    results = []
    for cls in np.unique(class_ids):
        indices = np.where(class_ids == cls)[0]

        keep = nms(boxes_xyxy[indices].tolist(), scores[indices], iou_threshold)

        for i in keep:
            k = indices[i]
            results.append({
                JSON_CLASSES_CLASS_ID: int(class_ids[k]),
                JSON_CLASSES_CONFIDENCE: float(scores[k]),
                JSON_CLASSES_BBOX: boxes_xyxy[k].tolist(),
            })

    return results

def draw_yolo_boxes(
    frame: np.ndarray,
    detections: list[dict[str, Any]],
    classes: list[dict[str, Any]]
):
    for det in detections:
        x1, y1, x2, y2 = map(int, det[JSON_CLASSES_BBOX])
        class_id = int(det[JSON_CLASSES_CLASS_ID])
        confidence = float(det[JSON_CLASSES_CONFIDENCE])

        if class_id not in classes:
            color = (127, 127, 127)
            label = str(class_id)
        else:
            color = classes[class_id][JSON_CLASSES_COLOR]
            label = f"{class_id}:{classes[class_id][JSON_CLASSES_NAME]}|{confidence:.2f}"

        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)

        (tw, th), baseline = cv2.getTextSize(
            label,
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            1
        )

        cv2.rectangle(
            frame,
            (x1, y1 - th - baseline - 4),
            (x1 + tw, y1),
            color,
            -1
        )

        # Text
        cv2.putText(
            frame,
            label,
            (x1, y1 - 4),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (0, 0, 0),
            1,
            cv2.LINE_AA
        )

    return frame























